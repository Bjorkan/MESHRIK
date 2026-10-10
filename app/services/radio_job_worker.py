"""Exactly one command executor over the existing RadioRuntime/RadioManager lock.

Producer migration is deliberately NOT part of #38/#39. Existing radio_operation
callers retain the same lower-level lock and do not pass through this worker.
A command callback executes only during the short transport stage; separate
response/ACK waiters (response tracker #40) call scheduler.transition afterwards.

A command timeout is *not* proof that firmware did not transmit. Cancellation
of the Python task is cooperative. If it refuses cancellation, the worker is
quarantined (no further commands) and the operator must restart the process;
no second worker/transport is spawned and the lock is not forcibly released.
"""

import asyncio
import logging
import os
from collections.abc import Awaitable, Callable
from enum import StrEnum
from pathlib import Path
from typing import Any
from uuid import UUID

from app.config import settings
from app.services.radio_job_scheduler import (
    RadioJobScheduler,
    RadioQueueUnavailableError,
)
from app.services.radio_jobs import (
    TERMINAL_STATES,
    RadioJobKind,
    RadioJobPriority,
    RadioJobResult,
    RadioJobSnapshot,
    RadioJobState,
)
from app.services.radio_runtime import RadioRuntime, radio_runtime

logger = logging.getLogger(__name__)


class RadioCommandOutcome(StrEnum):
    """Transport-stage result, NOT RF delivery confirmation."""

    FINISHED = "finished"  # local read/config only
    AWAITING_ACK = "awaiting_ack"
    AWAITING_RESPONSE = "awaiting_response"
    UNCERTAIN = "uncertain"


Command = Callable[[Any], Awaitable[RadioCommandOutcome]]
_RADIO_SEND_KINDS = frozenset({RadioJobKind.DIRECT_MESSAGE, RadioJobKind.CHANNEL_MESSAGE})


class RadioProcessLease:
    """OS-level advisory lock across worker processes sharing the radio DB.

    This prevents a multi-worker uvicorn deployment from running multiple
    startup radio monitors/workers. On Unix use flock; on Windows use msvcrt.
    Keep the lock for the entire lifespan, not just transport acquisition.
    """

    def __init__(self, lock_path: Path | None = None):
        db_path = Path(settings.database_path).absolute()
        self.path = lock_path or db_path.with_suffix(db_path.suffix + ".radio-owner.lock")
        self._fd: int | None = None

    def acquire(self) -> None:
        if self._fd is not None:
            return
        self.path.parent.mkdir(parents=True, exist_ok=True)
        fd = os.open(self.path, os.O_CREAT | os.O_RDWR, 0o600)
        try:
            if os.fstat(fd).st_size == 0:
                os.write(fd, b"\0")
            if os.name == "nt":
                import msvcrt

                os.lseek(fd, 0, os.SEEK_SET)
                msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
            else:
                import fcntl

                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as exc:
            os.close(fd)
            raise RuntimeError(
                "Another MESHRIK process already owns this radio. "
                "Run uvicorn with exactly one worker (--workers 1)."
            ) from exc
        self._fd = fd

    def release(self) -> None:
        fd = self._fd
        if fd is None:
            return
        self._fd = None
        try:
            if os.name == "nt":
                import msvcrt

                os.lseek(fd, 0, os.SEEK_SET)
                msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)
            else:
                import fcntl

                fcntl.flock(fd, fcntl.LOCK_UN)
        finally:
            os.close(fd)


class RadioJobWorker:
    def __init__(
        self,
        scheduler: RadioJobScheduler,
        *,
        runtime: RadioRuntime = radio_runtime,
        cancellation_grace_seconds: float = 0.2,
        poll_interval_seconds: float = 0.25,
    ):
        if cancellation_grace_seconds <= 0 or poll_interval_seconds <= 0:
            raise ValueError("Worker grace and polling intervals must be positive")
        self.scheduler = scheduler
        self.runtime = runtime
        self.cancellation_grace_seconds = cancellation_grace_seconds
        self.poll_interval_seconds = poll_interval_seconds
        self._commands: dict[UUID, Command] = {}
        self._runner: asyncio.Task | None = None
        self._active: asyncio.Task | None = None
        self._active_id: UUID | None = None
        self._quarantined = False
        self._command_started = False

    @property
    def running(self) -> bool:
        return self._runner is not None and not self._runner.done()

    @property
    def quarantined(self) -> bool:
        return self._quarantined

    def start(self) -> None:
        """Idempotent within a process; never start a second executor."""
        if self._quarantined or (self._active is not None and not self._active.done()):
            raise RadioQueueUnavailableError("Previous radio command is still running")
        if self.running:
            return
        self.scheduler.attach_worker(self)
        self.scheduler.change_generation(self._runtime_generation())
        self.scheduler.resume()
        self._runner = asyncio.create_task(self._run(), name="radio-job-worker")

    def _runtime_generation(self) -> int:
        return int(getattr(self.runtime, "radio_generation", 0))

    def _connected(self) -> bool:
        return bool(self.runtime.is_connected) and not bool(
            getattr(self.runtime, "is_setup_in_progress", False)
        )

    def submit(
        self,
        kind: RadioJobKind,
        command: Command,
        *,
        priority: RadioJobPriority = RadioJobPriority.NORMAL,
        **options: Any,
    ) -> RadioJobSnapshot:
        """Commands are transient Python callbacks, never public job fields."""
        if not self.running or self._quarantined or not self._connected():
            raise RadioQueueUnavailableError("Radio not available for queued commands")
        self._sync_generation()
        snapshot = self.scheduler.submit(kind, priority=priority, **options)
        self._commands.setdefault(snapshot.id, command)  # replay/coalesce keeps original command
        return snapshot

    def cancel(self, job_id: UUID) -> RadioJobSnapshot:
        """Queue: guarantee no send. Executing: request only; do not cancel RF.

        Awaiting: stop observing replies, NOT an RF packet retraction.
        """
        snapshot = self.scheduler.request_cancellation(job_id)
        if snapshot.state in TERMINAL_STATES and self.scheduler is radio_job_scheduler:
            from app.services.radio_response_tracker import radio_response_tracker

            radio_response_tracker.release(job_id)
        if snapshot.state in TERMINAL_STATES:
            self._commands.pop(job_id, None)
        return snapshot

    def _sync_generation(self) -> None:
        current = self._runtime_generation()
        if current != self.scheduler.generation:
            self.scheduler.change_generation(current)
            self._discard_completed_commands()

    def _discard_completed_commands(self) -> None:
        for job_id in list(self._commands):
            snapshot = self.scheduler.get(job_id)
            if snapshot is None or snapshot.state in TERMINAL_STATES:
                self._commands.pop(job_id, None)

    @staticmethod
    def _consume_completion(task: asyncio.Task) -> None:
        if not task.cancelled():
            try:
                task.exception()
            except Exception:
                # Never log exception contents; transport errors may contain credentials.
                logger.error("Late radio command completed with an error")

    async def _execute(self, snapshot: RadioJobSnapshot, command: Command) -> RadioCommandOutcome:
        # This is the same lock used by all legacy producers, post-connect setup
        # and disconnect. Never retain the lock while awaiting RF confirmations.
        async with self.runtime.radio_operation(f"job_{snapshot.kind.value}") as mc:
            if self._runtime_generation() != snapshot.radio_generation or not self._connected():
                raise _StaleTransport()
            self._command_started = True
            return await command(mc)

    async def _dispatch(self, snapshot: RadioJobSnapshot, command: Command) -> None:
        task = asyncio.create_task(self._execute(snapshot, command), name="radio-job-command")
        self._active, self._active_id = task, snapshot.id
        self._command_started = False
        try:
            deadline = snapshot.command_deadline
            assert deadline is not None
            timeout = max(0, (deadline - self.scheduler._now()).total_seconds())
            done, _ = await asyncio.wait({task}, timeout=timeout)
            if not done:
                task.cancel()
                done, _ = await asyncio.wait({task}, timeout=self.cancellation_grace_seconds)
                # A command which crossed the transport boundary may still
                # have transmitted. Even cooperative cancellation cannot
                # prove the device's state, so fail closed until restart.
                if self._command_started or not done:
                    self._finish_if_current(
                        snapshot, RadioJobState.UNKNOWN, RadioJobResult.COMMAND_TIMEOUT
                    )
                    self._quarantined = True
                    self.scheduler.shutdown()
                    logger.critical("Radio command timed out; worker quarantined")
                    if not done:
                        task.add_done_callback(self._consume_completion)
                else:
                    # Timeout before entering the transport command (e.g.
                    # legacy radio lock contention); nothing was sent.
                    self._finish_if_current(
                        snapshot, RadioJobState.FAILED, RadioJobResult.COMMAND_TIMEOUT
                    )
                return
            try:
                outcome = task.result()
            except _StaleTransport:
                self._finish_if_current(
                    snapshot, RadioJobState.UNKNOWN, RadioJobResult.RADIO_CHANGED
                )
                return
            except asyncio.CancelledError:
                self._finish_if_current(
                    snapshot, RadioJobState.UNKNOWN, RadioJobResult.TRANSMISSION_UNCERTAIN
                )
                return
            except Exception as exc:
                # Exception contents may include transport addresses/secrets.
                logger.warning("Radio job transport error (%s)", type(exc).__name__)
                self._finish_if_current(
                    snapshot, RadioJobState.UNKNOWN, RadioJobResult.COMMAND_ERROR
                )
                return

            if self._runtime_generation() != snapshot.radio_generation:
                self._sync_generation()
                return
            if not self._connected():
                self.scheduler.fence_disconnect()
                return
            if outcome == RadioCommandOutcome.AWAITING_ACK:
                self._finish_if_current(snapshot, RadioJobState.AWAITING_ACK)
            elif outcome == RadioCommandOutcome.AWAITING_RESPONSE:
                self._finish_if_current(snapshot, RadioJobState.AWAITING_RESPONSE)
            elif outcome == RadioCommandOutcome.FINISHED and snapshot.kind not in _RADIO_SEND_KINDS:
                self._finish_if_current(
                    snapshot, RadioJobState.COMPLETED, RadioJobResult.COMMAND_FINISHED
                )
            else:
                # Transport accepted/send command != RF delivery or ACK.
                self._finish_if_current(
                    snapshot, RadioJobState.UNKNOWN, RadioJobResult.TRANSMISSION_UNCERTAIN
                )
        finally:
            if task.done():
                self._active, self._active_id = None, None
            # If not done, retain the task as evidence that this worker may
            # still have an in-flight operation and prohibit worker restart.
            current = self.scheduler.get(snapshot.id)
            if current is None or current.state in TERMINAL_STATES:
                self._commands.pop(snapshot.id, None)

    def _finish_if_current(
        self, snapshot: RadioJobSnapshot, state: RadioJobState, result: RadioJobResult | None = None
    ) -> None:
        current = self.scheduler.get(snapshot.id)
        if current is None or current.state != RadioJobState.EXECUTING:
            return  # reconnect/shutdown already fenced off this completion
        self.scheduler.transition(snapshot.id, state, result=result)

    async def _run(self) -> None:
        try:
            while not self._quarantined and self.scheduler.accepting:
                self._sync_generation()
                self.scheduler.sweep()
                self._discard_completed_commands()
                if self._connected():
                    # A scoped CLI response/polling session must not be disrupted by
                    # another scheduled command. Import lazily (tracker owns
                    # reservations; the worker owns the command permit).
                    from app.services.radio_response_tracker import radio_response_tracker

                    eligible = (
                        radio_response_tracker.can_dispatch
                        if self.scheduler is radio_job_scheduler
                        else None
                    )
                    snapshot = self.scheduler.take_next(eligible=eligible)
                    if snapshot is not None:
                        command = self._commands.get(snapshot.id)
                        if command is None:
                            self._finish_if_current(
                                snapshot, RadioJobState.FAILED, RadioJobResult.REJECTED
                            )
                        else:
                            await self._dispatch(snapshot, command)
                        continue
                else:
                    self.scheduler.fence_disconnect()
                    self._discard_completed_commands()
                await self.scheduler.wait_for_change(self.poll_interval_seconds)
        except asyncio.CancelledError:
            raise
        finally:
            # stop() may interrupt _dispatch while transport task is alive.
            active = self._active
            if active is not None and not active.done():
                active.cancel()
                done, _ = await asyncio.wait({active}, timeout=self.cancellation_grace_seconds)
                if not done:
                    active.add_done_callback(self._consume_completion)
                    self._quarantined = True
                    logger.critical("Radio worker shutdown left an unresponsive transport command")
            self._commands.clear()
            if not self._quarantined:
                self.scheduler.detach_worker(self)

    async def stop(self) -> None:
        """Bounded cooperative shutdown; no replay after a stopped worker."""
        self.scheduler.shutdown()
        task = self._runner
        if task is None:
            return
        if not task.done():
            task.cancel()
        done, _ = await asyncio.wait({task}, timeout=self.cancellation_grace_seconds * 2 + 0.1)
        if not done:
            self._quarantined = True
            logger.critical("Radio worker did not stop within shutdown budget")
        else:
            self._runner = None
            if not self._quarantined:
                self.scheduler.detach_worker(self)
            if not task.cancelled():
                task.result()


class _StaleTransport(Exception):
    pass


# One scheduler/worker per process; no MeshCore instance is created here.
radio_job_scheduler = RadioJobScheduler()
radio_job_worker = RadioJobWorker(radio_job_scheduler)
