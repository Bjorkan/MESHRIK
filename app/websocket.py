"""WebSocket manager for real-time updates."""

import asyncio
import logging
from typing import Any, cast

from fastapi import WebSocket

from app.events import dump_ws_event
from app.services.radio_jobs import RadioReadinessState

logger = logging.getLogger(__name__)

# Timeout for individual WebSocket send operations (seconds)
# Prevents a slow client from blocking broadcasts to other clients
SEND_TIMEOUT_SECONDS = 5.0


MAX_WS_CLIENT_BACKLOG = 512


class WebSocketManager:
    """One FIFO writer per client; a stalled browser never blocks another."""

    def __init__(self):
        self.active_connections: list[WebSocket] = []
        self._lock = asyncio.Lock()
        self._outboxes: dict[WebSocket, asyncio.Queue[str]] = {}
        self._writers: dict[WebSocket, asyncio.Task] = {}
        self.enqueued = 0
        self.submitted_to_socket = 0
        self.failed = 0
        self.overflows = 0

    async def connect(self, websocket: WebSocket) -> None:
        await websocket.accept()
        async with self._lock:
            if websocket not in self.active_connections:
                self.active_connections.append(websocket)
                self._outboxes[websocket] = asyncio.Queue(maxsize=MAX_WS_CLIENT_BACKLOG)
                self._writers[websocket] = asyncio.create_task(
                    self._write_client(websocket), name="websocket-client-writer"
                )
        logger.info("WebSocket client connected (%d total)", len(self.active_connections))

    async def disconnect(self, websocket: WebSocket) -> None:
        async with self._lock:
            if websocket in self.active_connections:
                self.active_connections.remove(websocket)
            self._outboxes.pop(websocket, None)
            writer = self._writers.pop(websocket, None)
        if writer is not None and writer is not asyncio.current_task():
            writer.cancel()
        logger.info("WebSocket client disconnected (%d remaining)", len(self.active_connections))

    async def _write_client(self, websocket: WebSocket) -> None:
        try:
            while True:
                queue = self._outboxes.get(websocket)
                if queue is None:
                    return
                body = await queue.get()
                try:
                    await asyncio.wait_for(websocket.send_text(body), timeout=SEND_TIMEOUT_SECONDS)
                    self.submitted_to_socket += 1
                except Exception:
                    self.failed += 1
                    return
                finally:
                    queue.task_done()
        finally:
            await self.disconnect(websocket)

    def enqueue(self, event_type: str, data: Any) -> None:
        """Synchronous enqueue preserves event call order before any await."""
        message = dump_ws_event(event_type, data)
        for conn, queue in list(self._outboxes.items()):
            try:
                queue.put_nowait(message)
                self.enqueued += 1
            except asyncio.QueueFull:
                self.overflows += 1
                # Force reconnect + canonical REST refetch instead of
                # showing a silently incomplete stream.
                writer = self._writers.get(conn)
                if writer is not None:
                    writer.cancel()

    async def broadcast(self, event_type: str, data: Any) -> None:
        self.enqueue(event_type, data)

    async def send_personal(self, websocket: WebSocket, event_type: str, data: Any) -> None:
        queue = self._outboxes.get(websocket)
        if queue is not None:
            try:
                queue.put_nowait(dump_ws_event(event_type, data))
            except asyncio.QueueFull:
                writer = self._writers.get(websocket)
                if writer is not None:
                    writer.cancel()


# Global instance
ws_manager = WebSocketManager()


def broadcast_event(event_type: str, data: dict, *, realtime: bool = True) -> None:
    """Schedule a broadcast without blocking.

    Convenience function that creates an asyncio task to broadcast
    an event to all connected WebSocket clients and forward to fanout modules.

    Args:
        event_type: Event type string (e.g. "message", "raw_packet")
        data: Event payload dict
        realtime: If False, skip fanout dispatch (used for historical decryption)
    """
    ws_manager.enqueue(event_type, data)

    if realtime:
        from app.fanout.manager import fanout_manager

        if event_type == "message":
            asyncio.create_task(fanout_manager.broadcast_message(data))

            from app.push.manager import push_manager

            asyncio.create_task(push_manager.dispatch_message(data))
        elif event_type == "raw_packet":
            asyncio.create_task(fanout_manager.broadcast_raw(data))
        elif event_type == "contact":
            asyncio.create_task(fanout_manager.broadcast_contact(data))


def broadcast_error(message: str, details: str | None = None) -> None:
    """Broadcast an error notification to all connected clients.

    This appears as a toast notification in the frontend.
    """
    data = {"message": message}
    if details:
        data["details"] = details
    ws_manager.enqueue("error", data)


def broadcast_success(message: str, details: str | None = None) -> None:
    """Broadcast a success notification to all connected clients.

    This appears as a toast notification in the frontend.
    """
    data = {"message": message}
    if details:
        data["details"] = details
    ws_manager.enqueue("success", data)


_last_radio_activity_status: tuple[bool, RadioReadinessState, int] | None = None
_RADIO_READINESS_STATES: set[str] = {
    "ready",
    "connected",
    "degraded",
    "failed",
    "initializing",
    "connecting",
    "disconnected",
    "paused",
}


def broadcast_health(radio_connected: bool, connection_info: str | None = None) -> None:
    """Broadcast health status change to all connected clients."""

    async def _broadcast():
        from app.routers.health import build_health_data

        data = await build_health_data(radio_connected, connection_info)
        await ws_manager.broadcast("health", data)

    # Health also changes for statistics/MQTT without any radio lifecycle event.
    # Capture readiness at call time (not in the asynchronously scheduled task).
    from app.services.radio_job_worker import radio_job_scheduler
    from app.services.radio_jobs import RadioActivityKind
    from app.services.radio_runtime import radio_runtime

    global _last_radio_activity_status
    raw_readiness = str(
        getattr(radio_runtime, "readiness_state", "ready" if radio_connected else "disconnected")
    )
    if not bool(getattr(radio_runtime, "connection_desired", True)):
        readiness: RadioReadinessState = "paused"
    elif not radio_connected:
        readiness = "disconnected"
    elif raw_readiness not in _RADIO_READINESS_STATES:
        readiness = "connected" if radio_connected else "disconnected"
    else:
        readiness = cast(RadioReadinessState, raw_readiness)
    snapshot = (radio_connected, readiness, int(getattr(radio_runtime, "radio_generation", 0)))
    if _last_radio_activity_status != snapshot:
        # Record the first observed state and each real transition; never
        # consume the bounded ring for identical periodic health broadcasts.
        previous = _last_radio_activity_status
        radio_job_scheduler.record_activity(
            RadioActivityKind.CONNECTION_CHANGED,
            previous_connected=previous[0] if previous else None,
            connected=snapshot[0],
            previous_readiness=previous[1] if previous else None,
            readiness=snapshot[1],
            radio_generation=snapshot[2],
        )
        _last_radio_activity_status = snapshot
    asyncio.create_task(_broadcast())
