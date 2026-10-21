"""Unwired asyncio TCP listener for isolated virtual Companion sessions."""

import asyncio
import contextlib
import itertools
from collections.abc import Callable

from app.repository.messages import MessageRepository

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
        self._session_ids: dict[VirtualCompanionSession, int] = {}
        self._session_sequence = itertools.count(1)
        self._session_tasks: set[asyncio.Task[None]] = set()

    @property
    def client_count(self) -> int:
        return len(self._sessions)

    @property
    def listening(self) -> bool:
        return self._server is not None

    @property
    def client_statuses(self) -> tuple[dict[str, object], ...]:
        """Return privacy-safe session metadata without socket peer addresses."""
        rows = []
        for session in self._sessions:
            session_id = self._session_ids.get(session)
            if session_id is None:
                continue
            rows.append(
                {
                    "session_id": f"session-{session_id}",
                    "status": "connected" if not session.closed else "closing",
                    "connected_at": session.connected_at,
                    "last_seen_at": session.last_seen_at,
                    "protocol_version": session.state.protocol_version,
                    "identity_verified": session.state.identity_generation is not None,
                }
            )
        return tuple(sorted(rows, key=lambda row: int(str(row["session_id"]).split("-")[1])))

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
        self._session_ids[session] = next(self._session_sequence)
        task = asyncio.current_task()
        if task is not None:
            self._session_tasks.add(task)
        try:
            await session.run()
        finally:
            self._sessions.discard(session)
            self._session_ids.pop(session, None)
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

    def notify_contact_changed(self, payload: bytes) -> None:
        """Fan out a validated contact update/tombstone to every live client."""
        for session in tuple(self._sessions):
            try:
                session.enqueue_push(payload)
            except Exception:
                asyncio.create_task(session.close())

    async def notify_send_confirmed(self, ack_code: str, trip_time_ms: int) -> None:
        """Push only after the matching outgoing row is durably acknowledged."""
        sessions = tuple(
            session for session in self._sessions if ack_code in session.state.pending_virtual_acks
        )
        message_ids = {session.state.pending_virtual_acks[ack_code] for session in sessions}
        confirmed_ids = set()
        for message_id in message_ids:
            ack_count, _paths = await MessageRepository.get_ack_and_paths(message_id)
            if ack_count > 0:
                confirmed_ids.add(message_id)
        for session in sessions:
            if session.state.pending_virtual_acks.get(ack_code) not in confirmed_ids:
                continue
            try:
                session.notify_send_confirmed(ack_code, trip_time_ms)
            except Exception:
                asyncio.create_task(session.close())
