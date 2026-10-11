"""Bounded, single-radio admission queue; no MeshCore access here.

All mutations are synchronous (no await between checks and writes) and thus
atomic on the owning asyncio event loop. A single worker may call take_next().
Priority aging: every ``aging_seconds`` queued, NORMAL/LOW priority improves
by 10 points while HIGH stays at 0. This prevents continuous HIGH arrivals
from aging in lockstep with an older LOW job and starving it;
within one priority FIFO is maintained. In-flight/awaiting jobs do not count
against queued capacity. This queue is intentionally NOT durable: callers must
persist message send state separately in the existing SQLite message tables.
"""

import asyncio
import math
from collections import deque
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timedelta
from uuid import UUID, uuid4

from app.services.radio_jobs import (
    ALLOWED_TRANSITIONS,
    TERMINAL_STATES,
    InvalidJobTransition,
    RadioActivityKind,
    RadioActivityRecord,
    RadioActivitySource,
    RadioJobEvent,
    RadioJobKind,
    RadioJobPriority,
    RadioJobResult,
    RadioJobSnapshot,
    RadioJobStage,
    RadioJobState,
    require_utc,
    utc_now,
)


class RadioAdmissionError(RuntimeError):
    status_code = 503
    retry_after_seconds = 5


class RadioQueueFullError(RadioAdmissionError):
    """Caller may retry later, not treat as a successful transmission."""


class RadioQueueUnavailableError(RadioAdmissionError):
    """The worker is shutting down or a transport must be recovered."""


class RadioIdempotencyConflict(ValueError):
    """A reused key cannot authorize a different operation or request."""


@dataclass
class _Record:
    snapshot: RadioJobSnapshot
    command_timeout_seconds: float
    response_timeout_seconds: float
    scope: str
    idempotency_key: str | None
    request_fingerprint: str | None
    coalesce_key: str | None


class RadioJobScheduler:
    def __init__(
        self,
        *,
        capacity: int = 64,
        aging_seconds: float = 30,
        history_limit: int = 256,
        event_limit: int = 512,
        clock: Callable[[], datetime] = utc_now,
    ):
        if capacity < 1 or aging_seconds <= 0 or history_limit < 1 or event_limit < 1:
            raise ValueError(
                "Queue capacity, fairness interval and history limits must be positive"
            )
        self.capacity = capacity
        self.aging_seconds = aging_seconds
        self.history_limit = history_limit
        self._clock = clock
        self._records: dict[UUID, _Record] = {}
        self._sequence = 0
        self._events: deque[RadioJobEvent] = deque(maxlen=event_limit)
        self._activities: deque[RadioActivityRecord] = deque(maxlen=event_limit)
        self._activity_listeners: list[Callable[[RadioActivityRecord], None]] = []
        self._activity_dropped_through = 0
        self._changed = asyncio.Event()
        self._accepting = True
        self._generation = 0
        self._worker_owner: object | None = None
        self._listeners: list[Callable[[RadioJobSnapshot], None]] = []

    def _now(self) -> datetime:
        return require_utc(self._clock())

    def attach_worker(self, owner: object) -> None:
        if self._worker_owner is not None and self._worker_owner is not owner:
            raise RadioQueueUnavailableError("Only one radio command worker is allowed")
        if self._worker_owner is None:
            # TestClient/lifespan restarts can use a fresh asyncio loop. The
            # old Event is loop-bound once waited on, so rebind it here only
            # when the previous worker has fully stopped.
            self._changed = asyncio.Event()
        self._worker_owner = owner

    def detach_worker(self, owner: object) -> None:
        if self._worker_owner is owner:
            self._worker_owner = None

    @property
    def generation(self) -> int:
        return self._generation

    @property
    def accepting(self) -> bool:
        return self._accepting

    @property
    def queue_size(self) -> int:
        return sum(r.snapshot.state == RadioJobState.QUEUED for r in self._records.values())

    def list_jobs(self) -> list[RadioJobSnapshot]:
        return sorted((r.snapshot for r in self._records.values()), key=lambda s: s.sequence)

    def events_since(self, sequence: int = 0) -> list[RadioJobEvent]:
        return [event for event in self._events if event.sequence > sequence]

    @property
    def sequence(self) -> int:
        return self._sequence

    def activities_since(self, sequence: int = 0) -> tuple[list[RadioActivityRecord], bool]:
        """Ordered retained inbound history and explicit replay-gap indication."""
        gap = sequence < self._activity_dropped_through
        return [event for event in self._activities if event.sequence > sequence], gap

    def subscribe_activity(
        self, listener: Callable[[RadioActivityRecord], None]
    ) -> Callable[[], None]:
        self._activity_listeners.append(listener)

        def unsubscribe() -> None:
            if listener in self._activity_listeners:
                self._activity_listeners.remove(listener)

        return unsubscribe

    def record_activity(
        self, kind: RadioActivityKind, *, job_id: UUID | None = None
    ) -> RadioActivityRecord:
        """Public activity is an allowlisted classification, never a raw event."""
        if not isinstance(kind, RadioActivityKind):
            raise ValueError("Only predefined sanitized radio activity kinds are allowed")
        if job_id is not None and self.get(job_id) is None:
            raise ValueError("Activity correlation requires a known local job")
        self._sequence += 1
        activity = RadioActivityRecord(
            sequence=self._sequence,
            at=self._now(),
            kind=kind,
            source=(
                RadioActivitySource.RAW_RF_LOG
                if kind == RadioActivityKind.PACKET_RECEIVED
                else RadioActivitySource.RADIO_LIFECYCLE
                if kind == RadioActivityKind.CONNECTION_CHANGED
                else RadioActivitySource.MESHCORE_EVENT
            ),
            job_id=job_id,
            radio_generation=self._generation,
        )
        if self._activities.maxlen and len(self._activities) == self._activities.maxlen:
            self._activity_dropped_through = self._activities[0].sequence
        self._activities.append(activity)
        for listener in tuple(self._activity_listeners):
            listener(activity)
        return activity

    def get(self, job_id: UUID) -> RadioJobSnapshot | None:
        record = self._records.get(job_id)
        return record.snapshot if record is not None else None

    def subscribe(self, listener: Callable[[RadioJobSnapshot], None]) -> Callable[[], None]:
        """Observe sanitized state deltas; callbacks must not await or block."""
        self._listeners.append(listener)

        def unsubscribe() -> None:
            if listener in self._listeners:
                self._listeners.remove(listener)

        return unsubscribe

    def _publish(self, snapshot: RadioJobSnapshot) -> None:
        self._events.append(
            RadioJobEvent(
                job_id=snapshot.id,
                state=snapshot.state,
                version=snapshot.version,
                sequence=snapshot.sequence,
                at=snapshot.updated_at,
            )
        )
        self._changed.set()
        for listener in tuple(self._listeners):
            listener(snapshot)

    def _prune(self) -> None:
        terminal = sorted(
            (r for r in self._records.values() if r.snapshot.state in TERMINAL_STATES),
            key=lambda r: r.snapshot.sequence,
        )
        for old in terminal[: max(0, len(terminal) - self.history_limit)]:
            self._records.pop(old.snapshot.id, None)

    def has_inflight_coalesced_job(
        self, *, kind: RadioJobKind, scope: str, coalesce_key: str
    ) -> bool:
        """Check for an already admitted, not-yet-terminal periodic command.

        The caller must check and submit without awaiting between operations.
        This avoids ever attaching a second producer coroutine to a first
        job's transport closure when the scheduler coalesces descriptors.
        """
        return any(
            record.snapshot.kind == kind
            and record.scope == scope
            and record.coalesce_key == coalesce_key
            and record.snapshot.state not in TERMINAL_STATES
            for record in self._records.values()
        )

    def submit(
        self,
        kind: RadioJobKind,
        *,
        priority: RadioJobPriority = RadioJobPriority.NORMAL,
        scope: str = "global",
        idempotency_key: str | None = None,
        request_fingerprint: str | None = None,
        coalesce_key: str | None = None,
        queue_timeout_seconds: float = 60,
        command_timeout_seconds: float = 15,
        response_timeout_seconds: float = 30,
    ) -> RadioJobSnapshot:
        """Admit a payload-free descriptor; command closures live only in worker.

        Idempotency requires a producer-supplied SHA-256 digest of the entire
        validated request (including target and command parameters). Never pass
        raw request bodies, credentials or addresses as fingerprints/scope keys.
        """
        if not isinstance(kind, RadioJobKind) or not isinstance(priority, RadioJobPriority):
            raise ValueError("Job kind and priority must be typed enums")
        for name, value, ceiling in (
            ("queue", queue_timeout_seconds, 3600),
            ("command", command_timeout_seconds, 120),
            ("response", response_timeout_seconds, 3600),
        ):
            if not math.isfinite(value) or value <= 0 or value > ceiling:
                raise ValueError(f"{name} deadline must be between 0 and {ceiling} seconds")
        if not scope or len(scope) > 128:
            raise ValueError("Scope must be a bounded opaque key")
        if coalesce_key is not None and (not coalesce_key or len(coalesce_key) > 128):
            raise ValueError("Coalescing requires a bounded opaque key")
        if idempotency_key is not None:
            if not idempotency_key or len(idempotency_key) > 128:
                raise ValueError("Invalid idempotency key")
            if (
                not request_fingerprint
                or len(request_fingerprint) != 64
                or any(c not in "0123456789abcdef" for c in request_fingerprint)
            ):
                raise ValueError("Idempotency requires a lowercase SHA-256 request fingerprint")
        elif request_fingerprint is not None:
            raise ValueError("Fingerprint without an idempotency key is not useful")

        now = self._now()
        self.sweep(now)
        if not self._accepting:
            raise RadioQueueUnavailableError("Radio command queue unavailable")

        # Replay an existing request, including its terminal outcome, BEFORE
        # checking capacity. A different request may never share this key.
        if idempotency_key is not None:
            for record in self._records.values():
                if record.idempotency_key == idempotency_key and record.scope == scope:
                    if (
                        record.snapshot.kind != kind
                        or record.request_fingerprint != request_fingerprint
                    ):
                        raise RadioIdempotencyConflict("Idempotency key reused for another request")
                    return record.snapshot
        if coalesce_key is not None:
            for record in self._records.values():
                if (
                    record.coalesce_key == coalesce_key
                    and record.scope == scope
                    and record.snapshot.kind == kind
                    and record.snapshot.state not in TERMINAL_STATES
                ):
                    return record.snapshot
        if self.queue_size >= self.capacity:
            raise RadioQueueFullError("Radio command queue full; retry later")
        self._sequence += 1
        snapshot = RadioJobSnapshot(
            id=uuid4(),
            kind=kind,
            state=RadioJobState.QUEUED,
            priority=priority,
            version=1,
            sequence=self._sequence,
            radio_generation=self._generation,
            created_at=now,
            updated_at=now,
            queue_entered_at=now,
            queue_deadline=now + timedelta(seconds=queue_timeout_seconds),
            correlation_scope=uuid4(),
        )
        self._records[snapshot.id] = _Record(
            snapshot,
            command_timeout_seconds,
            response_timeout_seconds,
            scope,
            idempotency_key,
            request_fingerprint,
            coalesce_key,
        )
        self._publish(snapshot)
        self._prune()
        return snapshot

    def transition(
        self,
        job_id: UUID,
        new_state: RadioJobState,
        *,
        result: RadioJobResult | None = None,
    ) -> RadioJobSnapshot:
        record = self._records[job_id]
        old = record.snapshot
        if new_state not in ALLOWED_TRANSITIONS[old.state]:
            raise InvalidJobTransition(f"Cannot transition {old.state} -> {new_state}")
        if new_state == RadioJobState.EXECUTING and any(
            other.snapshot.state == RadioJobState.EXECUTING
            for other in self._records.values()
            if other.snapshot.id != job_id
        ):
            raise InvalidJobTransition("Single radio command permit is occupied")
        now = self._now()
        self._sequence += 1
        stage_for_state = {
            RadioJobState.QUEUED: RadioJobStage.WAITING_TURN,
            RadioJobState.EXECUTING: RadioJobStage.TRANSPORT_COMMAND,
            RadioJobState.AWAITING_RESPONSE: RadioJobStage.WAITING_FOR_RESPONSE,
            RadioJobState.AWAITING_ACK: RadioJobStage.WAITING_FOR_ACK,
            RadioJobState.RETRYING: RadioJobStage.RETRY_PENDING,
            RadioJobState.COMPLETED: RadioJobStage.FINISHED,
            RadioJobState.FAILED: RadioJobStage.FAILED,
            RadioJobState.CANCELLED: RadioJobStage.CANCELLED,
            RadioJobState.UNKNOWN: RadioJobStage.UNCERTAIN,
        }
        changes: dict = {
            "state": new_state,
            "stage": stage_for_state[new_state],
            "version": old.version + 1,
            "sequence": self._sequence,
            "updated_at": now,
            "result": result,
        }
        if new_state == RadioJobState.EXECUTING:
            changes["started_at"] = now
            changes["command_deadline"] = now + timedelta(seconds=record.command_timeout_seconds)
            changes["response_deadline"] = None
        elif new_state in (RadioJobState.AWAITING_ACK, RadioJobState.AWAITING_RESPONSE):
            changes["response_deadline"] = now + timedelta(seconds=record.response_timeout_seconds)
        elif new_state == RadioJobState.QUEUED:
            changes["queue_entered_at"] = now
            changes["queue_deadline"] = now + timedelta(seconds=record.command_timeout_seconds)
            changes["attempt"] = min(old.attempt + 1, 100)
        if new_state in TERMINAL_STATES:
            changes["completed_at"] = now
        record.snapshot = old.model_copy(update=changes)
        self._publish(record.snapshot)
        self._prune()
        return record.snapshot

    def request_cancellation(self, job_id: UUID) -> RadioJobSnapshot:
        snapshot = self._records[job_id].snapshot
        if snapshot.state == RadioJobState.QUEUED or snapshot.state == RadioJobState.RETRYING:
            return self.transition(
                job_id, RadioJobState.CANCELLED, result=RadioJobResult.CANCELLED_BEFORE_SEND
            )
        if snapshot.state in (RadioJobState.AWAITING_RESPONSE, RadioJobState.AWAITING_ACK):
            return self.transition(
                job_id, RadioJobState.CANCELLED, result=RadioJobResult.STOPPED_WAITING
            )
        if snapshot.state != RadioJobState.EXECUTING or snapshot.cancellation_requested:
            return snapshot
        self._sequence += 1
        changed = snapshot.model_copy(
            update={
                "version": snapshot.version + 1,
                "sequence": self._sequence,
                "updated_at": self._now(),
                "cancellation_requested": True,
            }
        )
        self._records[job_id].snapshot = changed
        self._publish(changed)
        return changed

    def sweep(self, now: datetime | None = None) -> None:
        """Expire queued/awaiting phases; no automatic transport retransmission."""
        now = require_utc(now) if now is not None else self._now()
        for record in list(self._records.values()):
            snap = record.snapshot
            if (
                snap.state == RadioJobState.QUEUED
                and snap.queue_deadline
                and now >= snap.queue_deadline
            ):
                self.transition(snap.id, RadioJobState.FAILED, result=RadioJobResult.QUEUE_EXPIRED)
            elif (
                snap.state in (RadioJobState.AWAITING_ACK, RadioJobState.AWAITING_RESPONSE)
                and snap.response_deadline
                and now >= snap.response_deadline
            ):
                self.transition(
                    snap.id, RadioJobState.UNKNOWN, result=RadioJobResult.RESPONSE_EXPIRED
                )

    def take_next(
        self, eligible: Callable[[RadioJobSnapshot], bool] | None = None
    ) -> RadioJobSnapshot | None:
        """Synchronous/atomic selection. Only the worker is allowed to call it."""
        self.sweep()
        if not self._accepting or any(
            r.snapshot.state == RadioJobState.EXECUTING for r in self._records.values()
        ):
            return None
        now = self._now()
        queued = (
            r.snapshot
            for r in self._records.values()
            if r.snapshot.state == RadioJobState.QUEUED
            and (eligible is None or eligible(r.snapshot))
        )
        candidates = sorted(
            queued,
            key=lambda snap: (
                int(snap.priority)
                - (
                    10 * int((now - snap.queue_entered_at).total_seconds() // self.aging_seconds)
                    if snap.priority != RadioJobPriority.HIGH
                    else 0
                ),
                snap.priority,
                snap.sequence,
            ),
        )
        if not candidates:
            return None
        return self.transition(candidates[0].id, RadioJobState.EXECUTING)

    def fence_disconnect(self) -> None:
        """Invalidate nonterminal jobs when a transport goes offline unexpectedly."""
        for record in list(self._records.values()):
            snap = record.snapshot
            if snap.state == RadioJobState.QUEUED:
                self.transition(snap.id, RadioJobState.FAILED, result=RadioJobResult.RADIO_CHANGED)
            elif snap.state in (
                RadioJobState.EXECUTING,
                RadioJobState.AWAITING_ACK,
                RadioJobState.AWAITING_RESPONSE,
                RadioJobState.RETRYING,
            ):
                self.transition(snap.id, RadioJobState.UNKNOWN, result=RadioJobResult.RADIO_CHANGED)

    def change_generation(self, generation: int) -> None:
        if generation < self._generation:
            raise ValueError("Radio generation cannot move backwards")
        if generation == self._generation:
            return
        self._generation = generation
        self.fence_disconnect()
        self._changed.set()

    def shutdown(self) -> None:
        """Reject admissions; never replay lost in-memory commands after restart."""
        self._accepting = False
        for record in list(self._records.values()):
            snap = record.snapshot
            if snap.state == RadioJobState.QUEUED or snap.state == RadioJobState.RETRYING:
                self.request_cancellation(snap.id)
            elif snap.state not in TERMINAL_STATES:
                self.transition(snap.id, RadioJobState.UNKNOWN, result=RadioJobResult.SHUTDOWN)
        self._changed.set()

    def resume(self) -> None:
        self._accepting = True
        self._changed.set()

    async def wait_for_change(self, timeout: float = 0.25) -> None:
        # Clear before sleeping; mutating operations set the event on the same
        # event loop and cannot interleave between clear and wait() scheduling.
        self._changed.clear()
        try:
            await asyncio.wait_for(self._changed.wait(), timeout=timeout)
        except TimeoutError:
            pass
