"""Explicit, deny-by-default virtual Companion command dispatch."""

from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Protocol

RESP_CODE_ERR = 0x01
ERR_CODE_UNSUPPORTED_CMD = 0x01
ERR_CODE_ILLEGAL_ARG = 0x06


class DispatchContext(Protocol):
    """Per-client state available to audited command adapters."""

    protocol_version: int | None
    identity_generation: int | None
    message_cursor: int
    metadata: dict[str, object]
    pending_virtual_acks: dict[str, int]


CommandResponse = bytes | tuple[bytes, ...]
CommandHandler = Callable[[bytes, DispatchContext], Awaitable[CommandResponse]]


@dataclass(frozen=True, slots=True)
class CommandSpec:
    """One audited command handler and its accepted request size."""

    handler: CommandHandler
    min_length: int
    max_length: int


class CommandDispatcher:
    """Dispatch only individually registered commands; everything else is denied."""

    def __init__(self) -> None:
        self._commands: dict[int, CommandSpec] = {}

    def register(
        self,
        command: int,
        handler: CommandHandler,
        *,
        min_length: int,
        max_length: int,
    ) -> None:
        if not 0 <= command <= 0xFF:
            raise ValueError("command must fit in one byte")
        if not 1 <= min_length <= max_length <= 176:
            raise ValueError("command lengths must be within the frame limit")
        if command in self._commands:
            raise ValueError(f"command 0x{command:02x} already registered")
        self._commands[command] = CommandSpec(handler, min_length, max_length)

    async def dispatch(self, payload: bytes, context: DispatchContext) -> CommandResponse:
        if not payload:
            return bytes((RESP_CODE_ERR, ERR_CODE_ILLEGAL_ARG))
        spec = self._commands.get(payload[0])
        if spec is None:
            return bytes((RESP_CODE_ERR, ERR_CODE_UNSUPPORTED_CMD))
        if not spec.min_length <= len(payload) <= spec.max_length:
            return bytes((RESP_CODE_ERR, ERR_CODE_ILLEGAL_ARG))
        response = await spec.handler(payload, context)
        if not response:
            raise ValueError("command handler returned an empty response")
        frames = (response,) if isinstance(response, bytes) else response
        if any(not frame or len(frame) > 176 for frame in frames):
            raise ValueError("command handler response exceeds frame limits")
        return response
