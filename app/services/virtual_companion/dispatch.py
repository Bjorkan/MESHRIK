"""Explicit, deny-by-default virtual Companion command dispatch."""

from collections.abc import Awaitable, Callable
from dataclasses import dataclass

RESP_CODE_ERR = 0x01
ERR_CODE_UNSUPPORTED_CMD = 0x01
ERR_CODE_ILLEGAL_ARG = 0x06

CommandHandler = Callable[[bytes], Awaitable[bytes]]


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

    async def dispatch(self, payload: bytes) -> bytes:
        if not payload:
            return bytes((RESP_CODE_ERR, ERR_CODE_ILLEGAL_ARG))
        spec = self._commands.get(payload[0])
        if spec is None:
            return bytes((RESP_CODE_ERR, ERR_CODE_UNSUPPORTED_CMD))
        if not spec.min_length <= len(payload) <= spec.max_length:
            return bytes((RESP_CODE_ERR, ERR_CODE_ILLEGAL_ARG))
        response = await spec.handler(payload)
        if not response:
            raise ValueError("command handler returned an empty response")
        if len(response) > 176:
            raise ValueError("command handler response exceeds frame limit")
        return response
