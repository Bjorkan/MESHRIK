"""Unwired asyncio TCP listener for isolated virtual Companion sessions."""

import asyncio
import contextlib
from collections.abc import Callable

from .dispatch import CommandDispatcher
from .session import VirtualCompanionSession

SessionFactory = Callable[
    [asyncio.StreamReader, asyncio.StreamWriter, CommandDispatcher],
    VirtualCompanionSession,
]


class VirtualCompanionServer:
    """Own one listener and any number of independent client sessions."""

    def __init__(
        self,
        dispatcher: CommandDispatcher,
        *,
        session_factory: SessionFactory = VirtualCompanionSession,
    ) -> None:
        self.dispatcher = dispatcher
        self.session_factory = session_factory
        self._server: asyncio.AbstractServer | None = None
        self._sessions: set[VirtualCompanionSession] = set()
        self._session_tasks: set[asyncio.Task[None]] = set()

    @property
    def client_count(self) -> int:
        return len(self._sessions)

    @property
    def listening(self) -> bool:
        return self._server is not None

    @property
    def sockets(self):
        if self._server is None:
            return ()
        return tuple(getattr(self._server, "sockets", None) or ())

    async def start(self, host: str, port: int) -> None:
        if self._server is not None:
            raise RuntimeError("virtual Companion listener is already running")
        self._server = await asyncio.start_server(self._accept_client, host, port)

    async def _accept_client(
        self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter
    ) -> None:
        session = self.session_factory(reader, writer, self.dispatcher)
        self._sessions.add(session)
        task = asyncio.current_task()
        if task is not None:
            self._session_tasks.add(task)
        try:
            await session.run()
        finally:
            self._sessions.discard(session)
            if task is not None:
                self._session_tasks.discard(task)

    async def stop(self) -> None:
        server, self._server = self._server, None
        if server is not None:
            server.close()
        sessions = tuple(self._sessions)
        await asyncio.gather(*(session.close() for session in sessions))
        tasks = tuple(task for task in self._session_tasks if task is not asyncio.current_task())
        for task in tasks:
            task.cancel()
        if tasks:
            with contextlib.suppress(asyncio.CancelledError):
                await asyncio.gather(*tasks, return_exceptions=True)
        if server is not None:
            await server.wait_closed()

    async def disconnect_clients(self) -> None:
        """Fence every current session without stopping the listener."""
        sessions = tuple(self._sessions)
        await asyncio.gather(*(session.close() for session in sessions))
        tasks = tuple(task for task in self._session_tasks if task is not asyncio.current_task())
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)

    def notify_message_waiting(self, message_id: int) -> None:
        """Fan out a content-free persisted-message hint to independent sessions."""
        for session in tuple(self._sessions):
            try:
                session.notify_message_waiting(message_id)
            except Exception:
                # Queue overflow or a closing writer affects only this client.
                asyncio.create_task(session.close())
