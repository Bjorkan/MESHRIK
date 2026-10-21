"""Read-only, database-backed Companion contact snapshots."""

import struct
from typing import Protocol

from app.models import Contact
from app.repository.contacts import CompanionContactSnapshot, ContactRepository

from .dispatch import CommandDispatcher, CommandResponse, DispatchContext

CMD_GET_CONTACTS = 0x04
CMD_GET_CONTACT_BY_KEY = 0x1E
RESP_CODE_ERR = 0x01
RESP_CODE_CONTACTS_START = 0x02
RESP_CODE_CONTACT = 0x03
RESP_CODE_END_OF_CONTACTS = 0x04
PUSH_CODE_CONTACT_DELETED = 0x8F
ERR_CODE_NOT_FOUND = 0x02
MAX_PATH_SIZE = 64


class ContactSnapshotRepository(Protocol):
    async def get_companion_snapshot(self, since: int = 0) -> CompanionContactSnapshot: ...


class VirtualCompanionContacts:
    """Serialize repository snapshots without touching the physical radio."""

    def __init__(self, repository: ContactSnapshotRepository = ContactRepository) -> None:
        self._repository = repository

    async def get_contacts(self, payload: bytes, _context: DispatchContext) -> CommandResponse:
        if len(payload) not in (1, 5):
            return bytes((RESP_CODE_ERR, 0x06))
        since = int.from_bytes(payload[1:5], "little") if len(payload) == 5 else 0
        snapshot = await self._repository.get_companion_snapshot(since)
        frames: list[bytes] = [struct.pack("<BI", RESP_CODE_CONTACTS_START, snapshot.total)]
        frames.extend(encode_contact(contact, revision) for contact, revision in snapshot.contacts)
        frames.extend(
            bytes((PUSH_CODE_CONTACT_DELETED,)) + bytes.fromhex(public_key)
            for public_key in snapshot.deleted_public_keys
        )
        frames.append(struct.pack("<BI", RESP_CODE_END_OF_CONTACTS, snapshot.high_water))
        return tuple(frames)

    async def get_contact_by_key(self, payload: bytes, _context: DispatchContext) -> bytes:
        requested_key = payload[1:].hex()
        snapshot = await self._repository.get_companion_snapshot(0)
        for contact, revision in snapshot.contacts:
            if contact.public_key.lower() == requested_key:
                return encode_contact(contact, revision)
        return bytes((RESP_CODE_ERR, ERR_CODE_NOT_FOUND))


def register_contact_commands(
    dispatcher: CommandDispatcher,
    adapter: VirtualCompanionContacts | None = None,
) -> VirtualCompanionContacts:
    adapter = adapter or VirtualCompanionContacts()
    dispatcher.register(CMD_GET_CONTACTS, adapter.get_contacts, min_length=1, max_length=5)
    dispatcher.register(
        CMD_GET_CONTACT_BY_KEY,
        adapter.get_contact_by_key,
        min_length=33,
        max_length=33,
    )
    return adapter


def encode_contact(contact: Contact, revision: int) -> bytes:
    """Encode the fixed 148-byte firmware ContactInfo response layout."""
    public_key = bytes.fromhex(contact.public_key)
    if len(public_key) != 32:
        raise ValueError("Companion contacts require a full 32-byte public key")

    path_len, path = _encode_path(contact)
    flags = contact.flags & 0xFF
    if contact.favorite:
        flags |= 0x01
    else:
        flags &= ~0x01

    result = bytearray((RESP_CODE_CONTACT,))
    result.extend(public_key)
    result.extend((contact.type if 0 <= contact.type <= 4 else 0, flags, path_len))
    result.extend(path.ljust(MAX_PATH_SIZE, b"\0"))
    result.extend(_fixed_name(contact.name or ""))
    result.extend(
        struct.pack(
            "<IiiI",
            _uint32(contact.last_advert),
            _coordinate(contact.lat, -90, 90),
            _coordinate(contact.lon, -180, 180),
            _uint32(revision),
        )
    )
    return bytes(result)


def _encode_path(contact: Contact) -> tuple[int, bytes]:
    path_hex, hop_count, hash_mode = contact.effective_route_tuple()
    if hop_count < 0:
        return 0xFF, b""
    try:
        path = bytes.fromhex(path_hex)
    except ValueError:
        return 0xFF, b""
    if not 0 <= hash_mode <= 2 or not 0 <= hop_count <= 0x3F:
        return 0xFF, b""
    if len(path) != hop_count * (hash_mode + 1) or len(path) > MAX_PATH_SIZE:
        return 0xFF, b""
    return (hash_mode << 6) | hop_count, path


def _fixed_name(value: str) -> bytes:
    encoded = value.encode("utf-8")[:31]
    while encoded:
        try:
            encoded.decode("utf-8")
            break
        except UnicodeDecodeError:
            encoded = encoded[:-1]
    return encoded.ljust(32, b"\0")


def _coordinate(value: float | None, low: float, high: float) -> int:
    if value is None or not low <= value <= high:
        return 0
    return round(value * 1_000_000)


def _uint32(value: int | None) -> int:
    if value is None:
        return 0
    return min(0xFFFFFFFF, max(0, int(value)))
