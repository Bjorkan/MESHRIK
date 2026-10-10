"""Correlate asynchronous RF replies without owning or blocking the radio command slot.

Reservations are installed before their matching transport command. Unambiguous
DM ACKs are confirmed *only* by the existing dm_ack_tracker/SQLite ACK path.
Firmware login/CLI replies have no request ID: concurrent same-target sessions
are forbidden and an ambiguous timeout fences the target until a new radio
session. A CLI session blocks *all* other scheduled command dispatch while it
owns the response/polling channel; it does not stop inbound event delivery.

This is the opt-in infrastructure for #42/#43 producer migrations. Legacy
producers deliberately keep their original subscriptions and send behavior.
"""

import asyncio
from collections.abc import Callable
from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any
from uuid import UUID

from app.services.radio_job_scheduler import RadioJobScheduler
from app.services.radio_jobs import (
    TERMINAL_STATES,
    RadioActivityKind,
    RadioJobResult,
    RadioJobSnapshot,
    RadioJobState,
)


class ResponseKind(StrEnum):
    DM_ACK = "dm_ack"
    REPEATER_LOGIN = "repeater_login"
    ROOM_LOGIN = "room_login"
    CLI = "cli"


class ResponseReservationConflict(ValueError):
    """Unsafe overlapping requests or ambiguous previous responses."""


@dataclass
class PendingResponse:
    """Private waiter; never serialized as a public job or activity event."""

    tracker: "RadioResponseTracker"
    job_id: UUID
    kind: ResponseKind
    generation: int
    target: str | None
    ack_code: str | None
    message_id: int | None
    future: asyncio.Future[RadioJobResult | None]
    subscriptions: list[Any] = field(default_factory=list)
    extra_ack_codes: set[str] = field(default_factory=set)
    closed: bool = False

    async def wait(self, timeout: float | None = None) -> RadioJobResult | None:
        """Wait for a correlation outcome, not for access to the radio lock."""
        try:
            # shield means a local caller timeout cannot cancel the tracker future.
            return await asyncio.wait_for(asyncio.shield(self.future), timeout)
        except TimeoutError:
            self.tracker.expire(self.job_id)
            return None
        except asyncio.CancelledError:
            self.unsubscribe()
            raise

    def unsubscribe(self) -> None:
        self.tracker.release(self.job_id)


class RadioResponseTracker:
    def __init__(
        self,
        scheduler: RadioJobScheduler,
        *,
        generation_provider: Callable[[], int] | None = None,
        max_pending: int = 128,
    ):
        if max_pending < 1:
            raise ValueError("Response tracking capacity must be positive")
        self.scheduler = scheduler
        self._generation_provider = generation_provider
        self.max_pending = max_pending
        self._pending: dict[UUID, PendingResponse] = {}
        self._ambiguous_targets: set[tuple[ResponseKind, str, int]] = set()
        self._generation = scheduler.generation
        self._unlisten = scheduler.subscribe(self._on_job_change)

    def _sync_generation(self) -> bool:
        # The transport can reconnect *between* worker polls. Fence stale
        # callback delivery immediately, before completing any waiter.
        if self._generation_provider is not None:
            live_generation = self._generation_provider()
            if live_generation > self.scheduler.generation:
                self.scheduler.change_generation(live_generation)
            if live_generation != self.scheduler.generation:
                return False
        if self.scheduler.generation == self._generation:
            return True
        self._generation = self.scheduler.generation
        for pending in list(self._pending.values()):
            self._close(pending, None, ambiguous=False)
        self._ambiguous_targets.clear()
        return True

    @staticmethod
    def _fence_key(
        kind: ResponseKind, target: str, generation: int
    ) -> tuple[ResponseKind, str, int]:
        # Both room and repeater logins use the SAME uncorrelated firmware
        # LOGIN_SUCCESS/LOGIN_FAILED events; a reply can satisfy neither anew.
        bucket = (
            ResponseKind.REPEATER_LOGIN
            if kind in (ResponseKind.REPEATER_LOGIN, ResponseKind.ROOM_LOGIN)
            else kind
        )
        return (bucket, target, generation)

    def reserve(
        self,
        job_id: UUID,
        *,
        kind: ResponseKind,
        target: str | None = None,
        ack_code: str | None = None,
        message_id: int | None = None,
        meshcore: Any = None,
    ) -> PendingResponse:
        """Reserve BEFORE sending. Targets/codes are private matching material.

        For DM, `message_id` and ACK code must refer to the existing durable
        ACK registration. A raw unmatched ACK must never settle this waiter.
        For login/CLI, install MeshCore event subscriptions before the command.
        """
        if not self._sync_generation():
            raise ResponseReservationConflict("Radio session is changing")
        if len(self._pending) >= self.max_pending:
            raise ResponseReservationConflict("Response tracking capacity reached")
        job = self.scheduler.get(job_id)
        if job is None or job.state not in (RadioJobState.QUEUED, RadioJobState.EXECUTING):
            raise ResponseReservationConflict("Job cannot reserve a response in this state")
        if job.radio_generation != self.scheduler.generation or job_id in self._pending:
            raise ResponseReservationConflict("Job already reserved or radio session changed")
        if not isinstance(kind, ResponseKind):
            raise ValueError("Unsupported response kind")
        if kind == ResponseKind.DM_ACK:
            if not ack_code or message_id is None or message_id < 0:
                raise ValueError("DM ACK requires the existing message ID and expected code")
            if any(p.ack_code == ack_code for p in self._pending.values()):
                raise ResponseReservationConflict("ACK already reserved")
        else:
            if not isinstance(target, str):
                raise ValueError("Login/CLI target must be a bounded private key")
            target = target.strip().lower()
            if not target or len(target) > 128:
                raise ValueError("Login/CLI target must be a bounded private key")
            if meshcore is None:
                raise ValueError("Login/CLI reservation requires the existing MeshCore instance")
            if self._fence_key(kind, target, self._generation) in self._ambiguous_targets:
                raise ResponseReservationConflict("Previous unconfirmed reply may arrive late")
            if any(
                p.target == target
                and p.kind
                in (ResponseKind.REPEATER_LOGIN, ResponseKind.ROOM_LOGIN, ResponseKind.CLI)
                for p in self._pending.values()
            ):
                raise ResponseReservationConflict("Conflicting target response session")
            if kind == ResponseKind.CLI and any(
                p.kind == ResponseKind.CLI for p in self._pending.values()
            ):
                raise ResponseReservationConflict("CLI polling channel is already reserved")
            if any(p.kind == ResponseKind.CLI for p in self._pending.values()):
                raise ResponseReservationConflict(
                    "CLI reply scope excludes other response sessions"
                )
        loop = asyncio.get_running_loop()
        pending = PendingResponse(
            self, job_id, kind, self._generation, target, ack_code, message_id, loop.create_future()
        )
        self._pending[job_id] = pending
        try:
            if kind != ResponseKind.DM_ACK:
                # Filtering at the MeshCore dispatcher prevents unrelated events
                # being mistaken for replies. Captured values stay private.
                from meshcore import EventType

                if kind == ResponseKind.CLI:
                    pending.subscriptions.append(
                        meshcore.subscribe(
                            EventType.CONTACT_MSG_RECV,
                            lambda _event: self.notify_reply(job_id, success=True),
                            attribute_filters={"pubkey_prefix": target, "txt_type": 1},
                        )
                    )
                else:
                    for event_type, success in (
                        (EventType.LOGIN_SUCCESS, True),
                        (EventType.LOGIN_FAILED, False),
                    ):
                        pending.subscriptions.append(
                            meshcore.subscribe(
                                event_type,
                                lambda _event, ok=success: self.notify_reply(job_id, success=ok),
                                attribute_filters={"pubkey_prefix": target},
                            )
                        )
        except BaseException:
            self._close(pending, None, ambiguous=False)
            raise
        return pending

    def can_dispatch(self, job: RadioJobSnapshot) -> bool:
        if not self._sync_generation():
            return False
        return not any(
            p.kind == ResponseKind.CLI and p.job_id != job.id for p in self._pending.values()
        )

    def associate_message_ack(self, ack_code: str, message_id: int) -> None:
        """Associate a retry's new expected ACK with the existing DM waiter.

        Only the durable ACK pipeline may call notify_ack; this just extends
        correlation after firmware returns another code for the SAME row.
        """
        if not self._sync_generation():
            return
        if any(
            p.message_id != message_id and (p.ack_code == ack_code or ack_code in p.extra_ack_codes)
            for p in self._pending.values()
        ):
            return  # never cross-link two messages
        for pending in self._pending.values():
            if pending.kind == ResponseKind.DM_ACK and pending.message_id == message_id:
                pending.extra_ack_codes.add(ack_code)

    def notify_ack(self, ack_code: str, message_id: int) -> None:
        """Called *after* durable dm_ack_tracker successfully applied the ACK."""
        if not self._sync_generation():
            return
        for pending in list(self._pending.values()):
            if (
                pending.kind == ResponseKind.DM_ACK
                and (pending.ack_code == ack_code or ack_code in pending.extra_ack_codes)
                and pending.message_id == message_id
            ):
                self._settle(pending, RadioJobResult.ACK_RECEIVED)

    def notify_reply(self, job_id: UUID, *, success: bool) -> None:
        if not self._sync_generation():
            return
        pending = self._pending.get(job_id)
        if pending is None or pending.kind == ResponseKind.DM_ACK or pending.future.done():
            return
        self.scheduler.record_activity(
            RadioActivityKind.CLI_RESPONSE
            if pending.kind == ResponseKind.CLI
            else RadioActivityKind.LOGIN_RESPONSE,
            job_id=job_id,
        )
        self._settle(
            pending,
            RadioJobResult.RESPONSE_RECEIVED if success else RadioJobResult.REJECTED,
        )

    def _settle(self, pending: PendingResponse, outcome: RadioJobResult) -> None:
        if pending.closed or pending.generation != self.scheduler.generation:
            return
        if not pending.future.done():
            pending.future.set_result(outcome)
        current = self.scheduler.get(pending.job_id)
        if current is not None and current.state in (
            RadioJobState.AWAITING_ACK,
            RadioJobState.AWAITING_RESPONSE,
        ):
            self.scheduler.transition(
                pending.job_id,
                RadioJobState.FAILED
                if outcome == RadioJobResult.REJECTED
                else RadioJobState.COMPLETED,
                result=outcome,
            )
            self._close(pending, outcome, ambiguous=False)
        # If reply arrived while EXECUTING, retain it until the worker moves
        # the job to AWAITING_*; listener then completes the job immediately.

    def _on_job_change(self, snapshot: RadioJobSnapshot) -> None:
        self._sync_generation()
        pending = self._pending.get(snapshot.id)
        if pending is None:
            return
        if snapshot.state in TERMINAL_STATES:
            self._close(
                pending,
                None,
                ambiguous=snapshot.started_at is not None and not pending.future.done(),
            )
        elif (
            snapshot.state in (RadioJobState.AWAITING_RESPONSE, RadioJobState.AWAITING_ACK)
            and pending.future.done()
        ):
            result = pending.future.result()
            if result is not None:
                self._settle(pending, result)

    def expire(self, job_id: UUID) -> None:
        pending = self._pending.get(job_id)
        if pending is None:
            return
        current = self.scheduler.get(job_id)
        if current and current.state in (
            RadioJobState.AWAITING_RESPONSE,
            RadioJobState.AWAITING_ACK,
        ):
            self.scheduler.transition(
                job_id, RadioJobState.UNKNOWN, result=RadioJobResult.RESPONSE_EXPIRED
            )
        self._close(pending, None, ambiguous=True)

    def release(self, job_id: UUID) -> None:
        pending = self._pending.get(job_id)
        if pending is None:
            return
        snapshot = self.scheduler.get(job_id)
        if snapshot is not None and snapshot.state in (
            RadioJobState.QUEUED,
            RadioJobState.RETRYING,
            RadioJobState.AWAITING_ACK,
            RadioJobState.AWAITING_RESPONSE,
        ):
            # A producer unwinding before dispatch must prevent the queued
            # command; after dispatch it can only stop observing the reply.
            self.scheduler.request_cancellation(job_id)
        self._close(pending, None, ambiguous=not pending.future.done())

    def _close(
        self, pending: PendingResponse, outcome: RadioJobResult | None, *, ambiguous: bool
    ) -> None:
        if pending.closed:
            return
        pending.closed = True
        self._pending.pop(pending.job_id, None)
        for subscription in pending.subscriptions:
            try:
                subscription.unsubscribe()
            except Exception:
                pass
        # A wire reply has no request ID: a subsequent attempt in the SAME
        # transport generation cannot safely distinguish a late duplicate.
        # Fail closed until reconnect (or an explicit future transport barrier),
        # even after a successful login. A never-dispatched queued job is safe.
        current = self.scheduler.get(pending.job_id)
        if (
            pending.kind != ResponseKind.DM_ACK
            and pending.target is not None
            and (ambiguous or (current is not None and current.started_at is not None))
        ):
            self._ambiguous_targets.add(
                self._fence_key(pending.kind, pending.target, pending.generation)
            )
        if not pending.future.done():
            pending.future.set_result(outcome)

    def shutdown(self) -> None:
        for pending in list(self._pending.values()):
            self._close(pending, None, ambiguous=False)
        self._ambiguous_targets.clear()


# Uses the same scheduler/worker generation and no extra radio connection.
# Imported lazily by ACK handling to preserve the existing message pipeline.
from app.services.radio_job_worker import radio_job_scheduler  # noqa: E402
from app.services.radio_runtime import radio_runtime  # noqa: E402

radio_response_tracker = RadioResponseTracker(
    radio_job_scheduler,
    generation_provider=lambda: int(getattr(radio_runtime, "radio_generation", 0)),
)
