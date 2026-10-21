"""Stable virtual channel slots backed only by the MESHRIK database."""

from dataclasses import dataclass
from typing import Protocol

from app.repository.channels import ChannelRepository, CompanionChannelRecord

from .dispatch import CommandDispatcher, DispatchContext

CMD_GET_CHANNEL = 0x1F
RESP_CODE_ERR = 0x01
RESP_CODE_CHANNEL_INFO = 0x12
ERR_CODE_NOT_FOUND = 0x02
DEFAULT_VIRTUAL_CHANNEL_CAPACITY = 40


class CompanionChannelRepository(Protocol):
    async def get_companion_channel(self, key: str) -> CompanionChannelRecord | None: ...


@dataclass(frozen=True, slots=True)
class VirtualChannelSlot:
    index: int
    key: str
    channel: CompanionChannelRecord


class VirtualCompanionChannels:
    """One immutable shared slot map; missing DB rows remain stale, never remap."""

    def __init__(
        self,
        channel_slots: list[str | None] | tuple[str | None, ...] = (),
        *,
        capacity: int = DEFAULT_VIRTUAL_CHANNEL_CAPACITY,
        repository: CompanionChannelRepository = ChannelRepository,
    ) -> None:
        if not 1 <= capacity <= 255:
            raise ValueError("virtual channel capacity must be between 1 and 255")
        if len(channel_slots) > capacity:
            raise ValueError("channel slot mapping exceeds virtual capacity")
        normalized: list[str | None] = []
        seen: set[str] = set()
        for key in channel_slots:
            if key is None:
                normalized.append(None)
                continue
            canonical = key.upper()
            if canonical in seen or not _valid_secret(canonical):
                raise ValueError("channel slots require unique 16-byte hexadecimal keys")
            seen.add(canonical)
            normalized.append(canonical)
        self.capacity = capacity
        self._slots = tuple(normalized) + (None,) * (capacity - len(normalized))
        self._repository = repository

    async def resolve_slot(self, index: int) -> VirtualChannelSlot | None:
        """Resolve against the configured key and current DB row, never by radio slot."""
        if not 0 <= index < self.capacity:
            return None
        key = self._slots[index]
        if key is None:
            return None
        channel = await self._repository.get_companion_channel(key)
        if channel is None or channel.key.upper() != key or not _valid_secret(channel.key):
            return None
        return VirtualChannelSlot(index=index, key=key, channel=channel)

    async def get_channel(self, payload: bytes, _context: DispatchContext) -> bytes:
        slot = await self.resolve_slot(payload[1])
        if slot is None:
            return bytes((RESP_CODE_ERR, ERR_CODE_NOT_FOUND))
        return encode_channel(slot)


def register_channel_commands(
    dispatcher: CommandDispatcher,
    adapter: VirtualCompanionChannels,
) -> None:
    dispatcher.register(CMD_GET_CHANNEL, adapter.get_channel, min_length=2, max_length=2)


def encode_channel(slot: VirtualChannelSlot) -> bytes:
    secret = bytes.fromhex(slot.key)
    if len(secret) != 16:
        raise ValueError("Companion channels require a 16-byte secret")
    return bytes((RESP_CODE_CHANNEL_INFO, slot.index)) + _fixed_name(slot.channel.name) + secret


def _fixed_name(value: str) -> bytes:
    encoded = value.encode("utf-8")[:31]
    while encoded:
        try:
            encoded.decode("utf-8")
            break
        except UnicodeDecodeError:
            encoded = encoded[:-1]
    return encoded.ljust(32, b"\0")


def _valid_secret(value: str) -> bool:
    if len(value) != 32:
        return False
    try:
        return len(bytes.fromhex(value)) == 16
    except ValueError:
        return False
