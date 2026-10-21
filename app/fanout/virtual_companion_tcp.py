"""Listener-owning fanout adapter for the virtual Companion integration.

This module participates only in integration lifecycle/status. Companion
commands never enter fanout event callbacks and no physical radio object is
available here.
"""

import asyncio
import contextlib
from dataclasses import replace
from typing import Any

from app.fanout.base import FanoutModule
from app.services.virtual_companion import VirtualCompanionServer
from app.services.virtual_companion.channels import (
    DEFAULT_VIRTUAL_CHANNEL_CAPACITY,
    VirtualCompanionChannels,
    register_channel_commands,
)
from app.services.virtual_companion.contacts import register_contact_commands
from app.services.virtual_companion.identity import (
    build_identity_dispatcher,
    get_identity_snapshot,
    get_runtime_generation,
)
from app.services.virtual_companion.messages import register_message_commands

NETWORK_WARNING = (
    "Raw Companion TCP is not protected by MESHRIK HTTP Basic auth. "
    "Keep loopback binding or use a VPN/mTLS gateway with allowlisted clients."
)
GENERATION_POLL_SECONDS = 0.25


class VirtualCompanionTcpModule(FanoutModule):
    def __init__(self, config_id: str, config: dict, *, name: str = "") -> None:
        super().__init__(config_id, config, name=name)
        capacity = int(config.get("virtual_channel_capacity", DEFAULT_VIRTUAL_CHANNEL_CAPACITY))
        channel_slots = config.get("channel_slots", [])
        self._channels = VirtualCompanionChannels(channel_slots, capacity=capacity)
        self._configured_channel_slots = sum(key is not None for key in channel_slots)

        def virtual_identity():
            return replace(get_identity_snapshot(), max_channels=self._channels.capacity)

        dispatcher = build_identity_dispatcher(virtual_identity)
        register_contact_commands(dispatcher)
        register_channel_commands(dispatcher, self._channels)
        register_message_commands(dispatcher, self._channels)
        self._server = VirtualCompanionServer(dispatcher)
        self._bind_host = str(config["bind_host"])
        self._port = int(config["port"])
        self._generation_task: asyncio.Task[None] | None = None

    async def start(self) -> None:
        try:
            await self._server.start(self._bind_host, self._port)
        except Exception as exc:
            self._set_last_error(_sanitize_listener_error(exc))
            raise
        self._generation_task = asyncio.create_task(
            self._watch_radio_generation(), name="virtual-companion-generation-watch"
        )
        self._set_last_error(None)

    async def stop(self) -> None:
        if self._generation_task is not None:
            self._generation_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._generation_task
            self._generation_task = None
        await self._server.stop()

    async def _watch_radio_generation(self) -> None:
        generation = get_runtime_generation()
        while True:
            await asyncio.sleep(GENERATION_POLL_SECONDS)
            current = get_runtime_generation()
            if current != generation:
                generation = current
                await self._server.disconnect_clients()

    def notify_message_available(self, data: dict) -> None:
        """Tickle clients only after a canonical incoming row was persisted."""
        message_id = data.get("id")
        if data.get("outgoing") is False and type(message_id) is int and message_id > 0:
            self._server.notify_message_waiting(message_id)

    @property
    def status(self) -> str:
        if self.last_error:
            return "error"
        return "listening" if self._server.listening else "disabled"

    @property
    def status_details(self) -> dict[str, Any]:
        return {
            "bind_host": self._bind_host,
            "port": self._port,
            "clients": self._server.client_count,
            "virtual_channel_capacity": self._channels.capacity,
            "configured_channel_slots": self._configured_channel_slots,
            "network_warning": NETWORK_WARNING,
        }


def _sanitize_listener_error(exc: Exception) -> str:
    """Keep operational errors useful without reflecting config or payloads."""
    if isinstance(exc, OSError):
        if exc.errno is not None:
            return f"Listener unavailable (OS error {exc.errno})"
        return "Listener unavailable"
    return f"Listener failed ({type(exc).__name__})"
