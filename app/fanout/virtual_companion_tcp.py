"""Listener-owning fanout adapter for the virtual Companion integration.

This module participates only in integration lifecycle/status. Companion
commands never enter fanout event callbacks and no physical radio object is
available here.
"""

from typing import Any

from app.fanout.base import FanoutModule
from app.services.virtual_companion import CommandDispatcher, VirtualCompanionServer

NETWORK_WARNING = (
    "Raw Companion TCP is not protected by MESHRIK HTTP Basic auth. "
    "Keep loopback binding or use a VPN/mTLS gateway with allowlisted clients."
)


class VirtualCompanionTcpModule(FanoutModule):
    def __init__(self, config_id: str, config: dict, *, name: str = "") -> None:
        super().__init__(config_id, config, name=name)
        self._server = VirtualCompanionServer(CommandDispatcher())
        self._bind_host = str(config["bind_host"])
        self._port = int(config["port"])

    async def start(self) -> None:
        try:
            await self._server.start(self._bind_host, self._port)
        except Exception as exc:
            self._set_last_error(_sanitize_listener_error(exc))
            raise
        self._set_last_error(None)

    async def stop(self) -> None:
        await self._server.stop()

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
            "network_warning": NETWORK_WARNING,
        }


def _sanitize_listener_error(exc: Exception) -> str:
    """Keep operational errors useful without reflecting config or payloads."""
    if isinstance(exc, OSError):
        if exc.errno is not None:
            return f"Listener unavailable (OS error {exc.errno})"
        return "Listener unavailable"
    return f"Listener failed ({type(exc).__name__})"
