"""Queue-backed compatibility bridge for the existing radio-operation producers.

The public HTTP handlers retain their original synchronous results while radio
command sections are admitted by the one worker. Only the *existing* worker
enters the RadioManager lock; callbacks and private request contents never
enter RadioJobSnapshot. During isolated unit tests (without a started lifespan)
the original context manager is used, allowing the legacy mocked transport to
remain testable. In an initialized application, loss of the worker fails closed.

This bridge deliberately holds the command slot for the full legacy context:
response-dependent handlers must be split into send and reply phases before
they can safely overlap. It is not permission to schedule arbitrary RF commands.
"""

import asyncio
import os
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager, contextmanager
from contextvars import ContextVar
from dataclasses import dataclass
from typing import Any
from uuid import UUID

from fastapi import HTTPException

from app.radio import RadioOperationBusyError
from app.services.radio_job_scheduler import RadioAdmissionError
from app.services.radio_job_worker import (
    RadioCommandOutcome,
    radio_job_scheduler,
    radio_job_worker,
)
from app.services.radio_jobs import (
    TERMINAL_STATES,
    RadioJobKind,
    RadioJobPriority,
    RadioJobSnapshot,
    RadioJobState,
)
from app.services.radio_response_tracker import ResponseKind, radio_response_tracker

# All classification is from trusted, static, application-owned operation names.
# No target keys, passwords, message text, CLI commands or transport errors are
# exposed through the job record.
_HIGH = {
    "send_direct_message",
    "retry_direct_message",
    "send_channel_message",
    "resend_channel_message",
    "echo_watchdog_resend",
}
# Only these three loops represent a *singleton* periodic maintenance task.
# Target-specific operations in _LOW must NEVER coalesce by operation name:
# two different contacts/repeaters would otherwise lose one command.
_SINGLETON_PERIODIC = frozenset(
    {
        "message_poll_loop",
        "periodic_advertisement",
        "periodic_sync",
    }
)

_LOW = {
    "message_poll_loop",
    "periodic_advertisement",
    "periodic_sync",
    "background_contact_reconcile",
    "ensure_contact_on_radio",
    "sync_recent_contacts_to_radio",
    "telemetry_collect",
    "radio_stats_sample",
    "community_stats_fetch",
}


def classify_operation(name: str) -> tuple[RadioJobKind, RadioJobPriority]:
    if name in _HIGH:
        kind = (
            RadioJobKind.DIRECT_MESSAGE
            if "direct_message" in name
            else RadioJobKind.CHANNEL_MESSAGE
        )
        return kind, RadioJobPriority.HIGH if name not in (
            "echo_watchdog_resend",
            "retry_direct_message",
        ) else RadioJobPriority.NORMAL
    if name == "periodic_advertisement":
        return RadioJobKind.PERIODIC_ADVERTISEMENT, RadioJobPriority.LOW
    if name in _LOW:
        return RadioJobKind.PERIODIC_SYNC, RadioJobPriority.LOW
    if name in ("repeater_login", "room_login"):
        return (
            RadioJobKind.REPEATER_LOGIN if name == "repeater_login" else RadioJobKind.ROOM_LOGIN,
            RadioJobPriority.NORMAL,
        )
    if "advertisement" in name:
        return RadioJobKind.ADVERTISEMENT, RadioJobPriority.NORMAL
    if name in ("update_radio_config", "set_flood_scope", "import_private_key"):
        return RadioJobKind.RADIO_SETTINGS, RadioJobPriority.NORMAL
    if "discover" in name or "trace" in name:
        return RadioJobKind.DISCOVERY, RadioJobPriority.NORMAL
    return RadioJobKind.RADIO_QUERY, RadioJobPriority.NORMAL


@dataclass
class _ProducerSession:
    job_id: UUID
    owner: asyncio.Task[Any] | None = None
    await_ack: bool = False
    successful: bool = False


_current_session: ContextVar[_ProducerSession | None] = ContextVar(
    "radio_producer_session", default=None
)


@dataclass
class _WorkerTransportScope:
    """Task-owned lock context; never inherited by fire-and-forget child tasks."""

    owner: asyncio.Task[Any]
    meshcore: Any


_worker_transport: ContextVar[_WorkerTransportScope | None] = ContextVar(
    "radio_worker_transport", default=None
)


@contextmanager
def active_worker_transport(mc: Any, job_id: UUID):
    """Permit one *worker task* to call existing domain services without a nested job.

    A child task may inherit ContextVars, but is NEVER allowed to reuse the
    parent's transport permit. It must submit its own scheduled operation.
    """
    owner = asyncio.current_task()
    assert owner is not None
    scope_token = _worker_transport.set(_WorkerTransportScope(owner, mc))
    session = _ProducerSession(job_id, owner=owner)
    session_token = _current_session.set(session)
    try:
        yield session
    finally:
        _current_session.reset(session_token)
        _worker_transport.reset(scope_token)


def reserve_direct_message_ack(ack_code: str, message_id: int) -> None:
    """Correlate a *durably persisted* DM with its firmware ACK code.

    Called only after the message row exists. ACK delivery itself remains owned
    by dm_ack_tracker + SQLite, never by unsolicited tracker events.
    """
    session = _current_session.get()
    if session is None or session.owner is not asyncio.current_task():
        return  # Untracked task or inherited ContextVar must not reserve ACKs.
    radio_response_tracker.reserve(
        session.job_id,
        kind=ResponseKind.DM_ACK,
        ack_code=ack_code,
        message_id=message_id,
    )
    session.await_ack = True


@asynccontextmanager
async def scheduled_radio_operation(
    runtime: Any,
    name: str,
    *,
    pause_polling: bool = False,
    suspend_auto_fetch: bool = False,
    blocking: bool = True,
    defer_when_busy: bool = False,
) -> AsyncIterator[Any]:
    """Enter the single worker command permit for a transport-critical section.

    An operation already running *inside the worker task* may call a domain
    service that uses this context manager. It reuses that same command permit,
    not a second queued job. No separate asyncio task may inherit that permit.
    Outside the worker, the producer owns a shielded release handshake so
    scoped configuration restoration is atomic until its `async with` exits.
    """
    existing = _worker_transport.get()
    if existing is not None and existing.owner is asyncio.current_task():
        if defer_when_busy:
            raise ValueError("A worker command cannot defer its own command permit")
        yield existing.meshcore
        return
    if defer_when_busy and (blocking or name not in _SINGLETON_PERIODIC):
        raise ValueError("Deferred admission is reserved for fail-fast background producers")
    operation_options = {
        **({"pause_polling": True} if pause_polling else {}),
        **({"suspend_auto_fetch": True} if suspend_auto_fetch else {}),
        **({"blocking": False} if not blocking else {}),
    }
    if not radio_job_worker.running:
        # No lifespan: standalone service functions and unit-test doubles.
        # If startup ever attached a worker and it stopped/quarantined, fail
        # closed instead of bypassing the scheduler on a live application.
        if (
            "PYTEST_CURRENT_TEST" not in os.environ
            or radio_job_scheduler._worker_owner is not None
            or radio_job_worker.quarantined
        ):
            raise HTTPException(status_code=503, detail="Radio command worker unavailable")
        async with runtime.raw_radio_operation(name, **operation_options) as mc:
            yield mc
        return

    # Previously "blocking=False" was a best-effort one-shot attempt. It
    # must not add a backlog while a user command is executing or queued.
    if (
        not blocking
        and not defer_when_busy
        and (
            radio_job_scheduler.queue_size > 0
            or any(j.state == RadioJobState.EXECUTING for j in radio_job_scheduler.list_jobs())
        )
    ):
        raise RadioOperationBusyError("Radio command queue busy")

    kind, priority = classify_operation(name)
    # A background source may have at most one pending or executing copy.
    # Even the deferred path cannot accumulate missed polling intervals.
    coalesce_key = f"periodic:{name}" if name in _SINGLETON_PERIODIC else None
    coalesce_scope = "radio-background"
    if coalesce_key is not None and radio_job_scheduler.has_inflight_coalesced_job(
        kind=kind, scope=coalesce_scope, coalesce_key=coalesce_key
    ):
        raise RadioOperationBusyError("Periodic command already pending")
    loop = asyncio.get_running_loop()
    entered: asyncio.Future[Any] = loop.create_future()
    released: asyncio.Future[None] = loop.create_future()
    failed: asyncio.Future[None] = loop.create_future()

    async def critical_section(mc: Any) -> RadioCommandOutcome:
        if not entered.done():
            entered.set_result(mc)
        # Shield ensures that an uncooperative producer still owns the lower-
        # level radio lock. The worker quarantines rather than double-issues.
        while not released.done():
            try:
                await asyncio.shield(released)
            except asyncio.CancelledError:
                # Leave the physical lock owned by this command until the
                # producer's finally/restore section has actually returned.
                continue
        if name in {"reboot_radio", "import_private_key"}:
            # A reboot/identity mutation is a lifecycle barrier. Fence all
            # pending jobs BEFORE releasing the worker's command permit;
            # otherwise another queued command could dispatch under stale
            # channel-slot/contact assumptions in the same event-loop turn.
            runtime.radio_generation = int(runtime.radio_generation) + 1
            runtime.reset_channel_send_cache()
            runtime.clear_pending_message_channel_slots()
        if not session.successful:
            return RadioCommandOutcome.UNCERTAIN
        if session.await_ack:
            return RadioCommandOutcome.AWAITING_ACK
        return (
            RadioCommandOutcome.UNCERTAIN
            if kind in (RadioJobKind.DIRECT_MESSAGE, RadioJobKind.CHANNEL_MESSAGE)
            else RadioCommandOutcome.FINISHED
        )

    session = _ProducerSession(job_id=UUID(int=0), owner=asyncio.current_task())
    try:
        job = radio_job_worker.submit(
            kind,
            critical_section,
            priority=priority,
            radio_options=operation_options,
            command_timeout_seconds=120,
            response_timeout_seconds=180 if kind == RadioJobKind.DIRECT_MESSAGE else 30,
            queue_timeout_seconds=180 if defer_when_busy else (5 if not blocking else 60),
            scope=coalesce_scope if coalesce_key else "global",
            coalesce_key=coalesce_key,
        )
    except RadioAdmissionError as exc:
        if not blocking:
            raise RadioOperationBusyError("Radio command queue busy") from exc
        raise HTTPException(
            status_code=503,
            detail="Radio command queue unavailable; retry after a short delay",
            headers={"Retry-After": "5"},
        ) from exc

    session.job_id = job.id

    def on_change(snapshot: RadioJobSnapshot) -> None:
        if (
            snapshot.id == job.id
            and snapshot.state in TERMINAL_STATES
            and not entered.done()
            and not failed.done()
        ):
            failed.set_result(None)

    unsubscribe = radio_job_scheduler.subscribe(on_change)
    started = False
    token = None
    try:
        done, _ = await asyncio.wait({entered, failed}, return_when=asyncio.FIRST_COMPLETED)
        if entered not in done:
            if not blocking:
                raise RadioOperationBusyError("Radio command not available")
            raise HTTPException(status_code=503, detail="Radio command was not dispatched")
        started = True
        token = _current_session.set(session)
        yield entered.result()
        session.successful = True
    finally:
        # No producer may keep the lock after its own critical section exits.
        if token is not None:
            _current_session.reset(token)
        if not released.done():
            released.set_result(None)
        if not started:
            radio_job_worker.cancel(job.id)
        unsubscribe()
