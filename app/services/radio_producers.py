"""Worker-executed adapters for synchronous radio producer APIs.

HTTP handlers and background producers submit private callbacks and await their
typed result while the callback itself runs in the one worker task. Command
inputs never enter the public RadioJobSnapshot. Hardware-free unit tests may
use the raw lock only when no application worker has ever been attached; an
initialized application fails closed if its worker is unavailable.
"""

import asyncio
import logging
import os
from collections.abc import Awaitable, Callable
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass
from typing import Any, TypeVar, cast
from uuid import UUID

from fastapi import HTTPException

from app.radio import RadioOperationBusyError
from app.request_context import get_request_id
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
    RadioJobResult,
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

# These deadlines bound the complete legacy-compatible command section. RF
# waits inside each operation have their own shorter protocol timeout; the
# worker deadline is the final fail-closed ceiling visible in Radio Activity.
_COMMAND_TIMEOUT_SECONDS = {
    "discover_mesh": 20,
    "radio_trace": 60,
    "request_trace": 60,
    "request_path_discovery": 45,
    "contact_telemetry": 45,
    "repeater_status": 55,
    "repeater_lpp_telemetry": 45,
    "repeater_neighbors": 45,
    "repeater_acl": 45,
    "repeater_regions_anon": 45,
    "community_jwt_sign": 45,
    "room_status": 45,
    "room_lpp_telemetry": 45,
    "room_acl": 45,
    "debug_support_snapshot": 60,
}


def classify_operation(name: str) -> tuple[RadioJobKind, RadioJobPriority]:
    companion_kinds = {
        "companion_local_cli": RadioJobKind.COMPANION_LOCAL_CLI,
        "remote_companion_cli": RadioJobKind.REMOTE_COMPANION_CLI,
        "send_channel_datagram": RadioJobKind.CHANNEL_DATAGRAM,
        "radio_advanced_diagnostics": RadioJobKind.RADIO_DIAGNOSTICS,
    }
    if name in companion_kinds:
        return companion_kinds[name], RadioJobPriority.NORMAL
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
    if name == "radio_stats_sample":
        return RadioJobKind.RADIO_STATS_SAMPLE, RadioJobPriority.LOW
    if name == "periodic_advertisement":
        return RadioJobKind.PERIODIC_ADVERTISEMENT, RadioJobPriority.LOW
    if name in _LOW:
        return RadioJobKind.PERIODIC_SYNC, RadioJobPriority.LOW
    if name in ("repeater_login", "room_login"):
        return (
            RadioJobKind.REPEATER_LOGIN if name == "repeater_login" else RadioJobKind.ROOM_LOGIN,
            RadioJobPriority.NORMAL,
        )
    if name in ("radio_trace", "request_trace"):
        return RadioJobKind.TRACE, RadioJobPriority.NORMAL
    if name.startswith(("repeater_", "room_")) or name == "send_repeater_command":
        return RadioJobKind.SERVER_QUERY, RadioJobPriority.NORMAL
    if name in (
        "contact_telemetry",
        "set_routing_override_on_radio",
    ):
        return RadioJobKind.CONTACT_QUERY, RadioJobPriority.NORMAL
    if "advertisement" in name:
        return RadioJobKind.ADVERTISEMENT, RadioJobPriority.NORMAL
    if name in ("update_radio_config", "set_flood_scope", "import_private_key"):
        return RadioJobKind.RADIO_SETTINGS, RadioJobPriority.NORMAL
    if "discover" in name or "trace" in name:
        return RadioJobKind.DISCOVERY, RadioJobPriority.NORMAL
    return RadioJobKind.RADIO_QUERY, RadioJobPriority.NORMAL


def command_timeout_for_operation(name: str) -> float:
    """Return a bounded worker deadline without exposing operation parameters."""
    return float(_COMMAND_TIMEOUT_SECONDS.get(name, 120))


@dataclass
class _ProducerSession:
    job_id: UUID
    owner: asyncio.Task[Any] | None = None
    await_ack: bool = False


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

_ResultT = TypeVar("_ResultT")
_MISSING = object()
logger = logging.getLogger(__name__)


def _elapsed_ms(start, end) -> int:
    return max(0, round((end - start).total_seconds() * 1000))


def _log_job_stage(
    *,
    request_id: str,
    operation: str,
    job: RadioJobSnapshot,
    stage: str,
    outcome: str,
    elapsed_ms: int,
) -> None:
    """Emit payload-free scheduler timing that can be joined to an HTTP request."""
    logger.info(
        "Radio operation request_id=%s job_id=%s generation=%d operation=%s "
        "stage=%s outcome=%s elapsed_ms=%d",
        request_id,
        job.id,
        job.radio_generation,
        operation,
        stage,
        outcome,
        elapsed_ms,
    )


def _fence_lifecycle_mutation(runtime: Any, name: str) -> None:
    if name not in {"reboot_radio", "import_private_key"}:
        return
    runtime.radio_generation = int(runtime.radio_generation) + 1
    runtime.reset_channel_send_cache()
    runtime.clear_pending_message_channel_slots()


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


async def run_scheduled_radio_command(
    runtime: Any,
    name: str,
    command: Callable[[Any], Awaitable[_ResultT]],
    *,
    pause_polling: bool = False,
    suspend_auto_fetch: bool = False,
    blocking: bool = True,
    defer_when_busy: bool = False,
) -> _ResultT:
    """Run a complete radio command callback in the single worker task.

    The callback itself executes in
    ``radio-job-command``, so its deadline can cancel the actual command phase
    and no HTTP/background task can keep using the transport after the worker
    has declared the job terminal.
    """
    request_id = get_request_id()
    existing = _worker_transport.get()
    if existing is not None and existing.owner is asyncio.current_task():
        if defer_when_busy:
            raise ValueError("A worker command cannot defer its own command permit")
        return await command(existing.meshcore)

    if defer_when_busy and (blocking or name not in _SINGLETON_PERIODIC):
        raise ValueError("Deferred admission is reserved for fail-fast background producers")
    operation_options = {
        **({"pause_polling": True} if pause_polling else {}),
        **({"suspend_auto_fetch": True} if suspend_auto_fetch else {}),
        **({"blocking": False} if not blocking else {}),
    }
    if not radio_job_worker.running:
        # Hardware-free unit tests intentionally run without the application
        # lifespan. A previously attached or quarantined production worker
        # must never fall back to the raw manager path.
        if (
            "PYTEST_CURRENT_TEST" not in os.environ
            or radio_job_scheduler._worker_owner is not None
            or radio_job_worker.quarantined
        ):
            raise HTTPException(status_code=503, detail="Radio command worker unavailable")
        async with runtime.raw_radio_operation(name, **operation_options) as mc:
            result = await command(mc)
            _fence_lifecycle_mutation(runtime, name)
            return result

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
    coalesce_key = f"periodic:{name}" if name in _SINGLETON_PERIODIC else None
    coalesce_scope = "radio-background"
    if coalesce_key is not None and radio_job_scheduler.has_inflight_coalesced_job(
        kind=kind, scope=coalesce_scope, coalesce_key=coalesce_key
    ):
        raise RadioOperationBusyError("Periodic command already pending")

    result: object = _MISSING
    command_error: BaseException | None = None

    async def worker_command(mc: Any) -> RadioCommandOutcome:
        nonlocal result, command_error
        try:
            result = await command(mc)
            _fence_lifecycle_mutation(runtime, name)
        except BaseException as exc:
            command_error = exc
            raise
        return (
            RadioCommandOutcome.UNCERTAIN
            if kind in (RadioJobKind.DIRECT_MESSAGE, RadioJobKind.CHANNEL_MESSAGE)
            else RadioCommandOutcome.FINISHED
        )

    try:
        job = radio_job_worker.submit(
            kind,
            worker_command,
            priority=priority,
            radio_options=operation_options,
            command_timeout_seconds=command_timeout_for_operation(name),
            queue_timeout_seconds=180 if defer_when_busy else (5 if not blocking else 60),
            scope=coalesce_scope if coalesce_key else "global",
            coalesce_key=coalesce_key,
        )
    except RadioAdmissionError as exc:
        logger.warning(
            "Radio operation request_id=%s operation=%s stage=queue outcome=not_admitted "
            "error_category=%s",
            request_id,
            name,
            type(exc).__name__,
        )
        if not blocking:
            raise RadioOperationBusyError("Radio command queue busy") from exc
        raise HTTPException(
            status_code=503,
            detail="Radio command queue unavailable; retry after a short delay",
            headers={"Retry-After": "5"},
        ) from exc

    loop = asyncio.get_running_loop()
    settled: asyncio.Future[RadioJobSnapshot] = loop.create_future()

    def on_change(snapshot: RadioJobSnapshot) -> None:
        command_released = snapshot.state in TERMINAL_STATES or snapshot.state in {
            RadioJobState.AWAITING_ACK,
            RadioJobState.AWAITING_RESPONSE,
        }
        if snapshot.id == job.id and command_released and not settled.done():
            settled.set_result(snapshot)

    unsubscribe = radio_job_scheduler.subscribe(on_change)
    current = radio_job_scheduler.get(job.id)
    if current is not None and (
        current.state in TERMINAL_STATES
        or current.state in {RadioJobState.AWAITING_ACK, RadioJobState.AWAITING_RESPONSE}
    ):
        settled.set_result(current)
    logger.info(
        "Radio operation request_id=%s job_id=%s generation=%d operation=%s "
        "stage=queue outcome=started elapsed_ms=0",
        request_id,
        job.id,
        job.radio_generation,
        name,
    )
    try:
        final = await settled
    except asyncio.CancelledError:
        current = radio_job_scheduler.get(job.id)
        if current is not None and current.state in {RadioJobState.QUEUED, RadioJobState.RETRYING}:
            radio_job_worker.cancel(job.id)
        current = radio_job_scheduler.get(job.id) or job
        logger.warning(
            "Radio operation request_id=%s job_id=%s generation=%d operation=%s "
            "stage=request outcome=cancelled elapsed_ms=%d error_category=cancellation",
            request_id,
            job.id,
            job.radio_generation,
            name,
            _elapsed_ms(job.created_at, current.updated_at),
        )
        raise
    finally:
        unsubscribe()

    if final.started_at is not None:
        _log_job_stage(
            request_id=request_id,
            operation=name,
            job=final,
            stage="queue",
            outcome="acquired",
            elapsed_ms=_elapsed_ms(final.queue_entered_at, final.started_at),
        )
        _log_job_stage(
            request_id=request_id,
            operation=name,
            job=final,
            stage="command",
            outcome=(final.result or final.state).value,
            elapsed_ms=_elapsed_ms(final.started_at, final.updated_at),
        )
    else:
        _log_job_stage(
            request_id=request_id,
            operation=name,
            job=final,
            stage="queue",
            outcome=(final.result or final.state).value,
            elapsed_ms=_elapsed_ms(final.queue_entered_at, final.updated_at),
        )

    if result is not _MISSING and final.state in {
        RadioJobState.COMPLETED,
        RadioJobState.UNKNOWN,
        RadioJobState.AWAITING_ACK,
        RadioJobState.AWAITING_RESPONSE,
    }:
        return cast(_ResultT, result)
    if isinstance(command_error, Exception):
        raise command_error
    if final.result == RadioJobResult.COMMAND_TIMEOUT:
        raise HTTPException(status_code=504, detail="Radio command timed out")
    if final.result == RadioJobResult.RADIO_CHANGED:
        raise HTTPException(status_code=423, detail="Radio changed while command was running")
    raise HTTPException(status_code=503, detail="Radio command did not complete")
