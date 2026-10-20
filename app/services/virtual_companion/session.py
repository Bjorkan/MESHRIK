"""Independent state and bounded I/O lifetime for one Companion TCP client."""

import asyncio
import contextlib
import itertools
from dataclasses import dataclass, field

from .dispatch import CommandDispatcher
from .framing import FrameError, encode_frame, read_frame

DEFAULT_OUTBOX_SIZE = 64
DEFAULT_READ_TIMEOUT = 30.0
DEFAULT_WRITE_TIMEOUT = 5.0


class ClientBackpressure(RuntimeError):
    """A client cannot keep up with its bounded output queue."""


@dataclass(slots=True)
class SessionState:
    """Mutable protocol state that must never be shared between clients."""

    protocol_version: int | None = None
    identity_generation: int | None = None
    contact_cursor: int = 0
    message_cursor: int = 0
    metadata: dict[str, object] = field(default_factory=dict)


class VirtualCompanionSession:
    def __init__(
        self,
        reader: asyncio.StreamReader,
        writer: asyncio.StreamWriter,
        dispatcher: CommandDispatcher,
        *,
        outbox_size: int = DEFAULT_OUTBOX_SIZE,
        read_timeout: float = DEFAULT_READ_TIMEOUT,
        write_timeout: float = DEFAULT_WRITE_TIMEOUT,
    ) -> None:
        if outbox_size < 1:
            raise ValueError("outbox_size must be positive")
        self.reader = reader
        self.writer = writer
        self.dispatcher = dispatcher
        self.state = SessionState()
        self.read_timeout = read_timeout
        self.write_timeout = write_timeout
        self._outbox: asyncio.PriorityQueue[tuple[int, int, bytes]] = asyncio.PriorityQueue(
            maxsize=outbox_size
        )
        self._sequence = itertools.count()
        self._writer_task: asyncio.Task[None] | None = None
        self._closed = False

    @property
    def closed(self) -> bool:
        return self._closed

    def enqueue_push(self, payload: bytes) -> None:
        """Queue best-effort asynchronous output without blocking other clients."""
        try:
            self._outbox.put_nowait((1, next(self._sequence), payload))
        except asyncio.QueueFull as exc:
            raise ClientBackpressure("client push queue is full") from exc

    def _enqueue_response(self, payload: bytes) -> None:
        try:
            self._outbox.put_nowait((0, next(self._sequence), payload))
        except asyncio.QueueFull as exc:
            raise ClientBackpressure("client response queue is full") from exc

    async def _enqueue_response_wait(self, payload: bytes) -> None:
        # Command replies are lossless. Waiting here applies bounded backpressure
        # while the writer's timeout still evicts a client that has stopped reading.
        await self._outbox.put((0, next(self._sequence), payload))

    async def _next_outbound(self) -> bytes:
        # Priority 0 responses cannot be starved by priority 1 notifications;
        # the monotonic sequence preserves FIFO order within each class.
        _priority, _sequence, payload = await self._outbox.get()
        return payload

    async def _write_loop(self) -> None:
        while True:
            payload = await self._next_outbound()
            self.writer.write(encode_frame(payload))
            await asyncio.wait_for(self.writer.drain(), timeout=self.write_timeout)

    async def _read_loop(self) -> None:
        while True:
            payload = await read_frame(self.reader, timeout=self.read_timeout)
            operation = asyncio.create_task(self.dispatcher.dispatch(payload, self.state))
            try:
                # Closing a virtual socket must not cancel an operation that a
                # later adapter has already handed to a shared domain service.
                response = await asyncio.shield(operation)
            except asyncio.CancelledError:
                operation.add_done_callback(
                    lambda task: None if task.cancelled() else task.exception()
                )
                raise
            frames = (response,) if isinstance(response, bytes) else response
            for frame in frames:
                await self._enqueue_response_wait(frame)

    async def run(self) -> None:
        self._writer_task = asyncio.create_task(
            self._write_loop(), name="virtual-companion-client-writer"
        )
        reader_task = asyncio.create_task(self._read_loop(), name="virtual-companion-client-reader")
        try:
            done, pending = await asyncio.wait(
                (reader_task, self._writer_task), return_when=asyncio.FIRST_COMPLETED
            )
            for task in pending:
                task.cancel()
            await asyncio.gather(*pending, return_exceptions=True)
            for task in done:
                task.result()
        except (EOFError, FrameError, ClientBackpressure, ConnectionError, TimeoutError):
            pass
        finally:
            if not reader_task.done():
                reader_task.cancel()
                await asyncio.gather(reader_task, return_exceptions=True)
            await self.close()

    async def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        if self._writer_task is not None and self._writer_task is not asyncio.current_task():
            self._writer_task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await self._writer_task
        self.writer.close()
        with contextlib.suppress(Exception):
            await self.writer.wait_closed()
