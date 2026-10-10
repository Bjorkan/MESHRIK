"""Shared access seam over the global RadioManager instance.

This module deliberately keeps behavior thin and forwarding-only. The goal is
to reduce direct `app.radio.radio_manager` imports across routers and helpers
without changing radio lifecycle, lock, or connection semantics.
"""

from collections.abc import Callable
from contextlib import asynccontextmanager
from typing import Any

from fastapi import HTTPException

import app.radio as radio_module


class RadioRuntime:
    """Thin forwarding wrapper around the process-global RadioManager."""

    def __init__(self, manager_or_getter=None):
        if manager_or_getter is None:
            self._manager_getter: Callable[[], Any] = lambda: radio_module.radio_manager
        elif callable(manager_or_getter):
            self._manager_getter = manager_or_getter
        else:
            self._manager_getter = lambda: manager_or_getter

    @property
    def manager(self) -> Any:
        return self._manager_getter()

    def __getattr__(self, name: str) -> Any:
        """Forward unknown attributes to the current global manager."""
        return getattr(self.manager, name)

    @staticmethod
    def _is_local_runtime_attr(name: str) -> bool:
        return name.startswith("_") or hasattr(RadioRuntime, name)

    def __setattr__(self, name: str, value: Any) -> None:
        if self._is_local_runtime_attr(name):
            object.__setattr__(self, name, value)
            return
        setattr(self.manager, name, value)

    def __delattr__(self, name: str) -> None:
        if self._is_local_runtime_attr(name):
            object.__delattr__(self, name)
            return
        delattr(self.manager, name)

    def require_connected(self):
        """Return MeshCore when available, mirroring existing HTTP semantics."""
        if self.is_setup_in_progress:
            raise HTTPException(status_code=423, detail="Radio is initializing")
        if not self.is_connected:
            raise HTTPException(status_code=423, detail="Radio not connected")
        mc = self.meshcore
        if mc is None:
            raise HTTPException(status_code=423, detail="Radio not connected")
        return mc

    @asynccontextmanager
    async def raw_radio_operation(self, name: str, **kwargs):
        """Lower-level manager lock, reserved for the single worker and setup."""
        async with self.manager.radio_operation(name, **kwargs) as mc:
            yield mc

    @asynccontextmanager
    async def radio_operation(self, name: str, **kwargs):
        """Admit producer critical sections through the one scheduler worker."""
        from app.services.radio_producers import scheduled_radio_operation

        async with scheduled_radio_operation(self, name, **kwargs) as mc:
            yield mc
        if name in {"reboot_radio", "import_private_key"}:
            # A device identity/reboot barrier invalidates all queued radio
            # assumptions (including loaded contact/channel slot caches).
            # The worker detects this generation change and fences old jobs;
            # no second radio owner is ever constructed.
            self.radio_generation = int(self.radio_generation) + 1
            self.reset_channel_send_cache()
            self.clear_pending_message_channel_slots()

    async def start_connection_monitor(self) -> None:
        await self.manager.start_connection_monitor()

    async def stop_connection_monitor(self) -> None:
        await self.manager.stop_connection_monitor()

    async def disconnect(self) -> None:
        await self.manager.disconnect()

    async def prepare_connected(self, *, broadcast_on_success: bool = True) -> bool:
        from app.services.radio_lifecycle import prepare_connected_radio

        return await prepare_connected_radio(
            self.manager, broadcast_on_success=broadcast_on_success
        )

    async def reconnect_and_prepare(self, *, broadcast_on_success: bool = True) -> bool:
        from app.services.radio_lifecycle import reconnect_and_prepare_radio

        return await reconnect_and_prepare_radio(
            self.manager,
            broadcast_on_success=broadcast_on_success,
        )


radio_runtime = RadioRuntime()
