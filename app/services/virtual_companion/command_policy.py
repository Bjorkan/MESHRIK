"""Exhaustive firmware command policy and safe DB-only auxiliary adapters."""

import logging
import struct
import time
from collections.abc import Callable
from dataclasses import dataclass
from enum import StrEnum

from app.models import Contact
from app.repository.contacts import (
    CompanionContactMutation,
    CompanionContactSnapshot,
    ContactRepository,
)
from app.services.contact_reconciliation import record_contact_name_and_reconcile
from app.websocket import broadcast_event

from .contacts import encode_contact
from .dispatch import CommandDispatcher, DispatchContext

logger = logging.getLogger(__name__)

RESP_CODE_OK = 0x00
RESP_CODE_ERR = 0x01
RESP_CODE_CURR_TIME = 0x09
PUSH_CODE_NEW_ADVERT = 0x8A
PUSH_CODE_CONTACT_DELETED = 0x8F
ERR_CODE_UNSUPPORTED_CMD = 0x01
ERR_CODE_NOT_FOUND = 0x02
ERR_CODE_BAD_STATE = 0x04
ERR_CODE_ILLEGAL_ARG = 0x06


class PolicyStatus(StrEnum):
    EXISTING = "existing adapter"
    LOCAL_READ = "safe local read"
    DB_MUTATION = "DB-only mutation"
    DENIED = "explicitly denied"


@dataclass(frozen=True, slots=True)
class CommandPolicy:
    name: str
    status: PolicyStatus
    reason: str


def _policy(name: str, status: PolicyStatus, reason: str) -> CommandPolicy:
    return CommandPolicy(name, status, reason)


# Complete MyMesh.cpp command inventory. Keeping denied commands in this map is
# intentional: a new firmware command cannot become reachable by omission.
FIRMWARE_COMMAND_POLICY: dict[int, CommandPolicy] = {
    0x01: _policy("CMD_APP_START", PolicyStatus.EXISTING, "verified cached identity"),
    0x02: _policy("CMD_SEND_TXT_MSG", PolicyStatus.EXISTING, "canonical DM service"),
    0x03: _policy("CMD_SEND_CHANNEL_TXT_MSG", PolicyStatus.EXISTING, "canonical channel service"),
    0x04: _policy("CMD_GET_CONTACTS", PolicyStatus.EXISTING, "durable DB snapshot"),
    0x05: _policy("CMD_GET_DEVICE_TIME", PolicyStatus.LOCAL_READ, "host UTC clock"),
    0x06: _policy("CMD_SET_DEVICE_TIME", PolicyStatus.DENIED, "host/radio clock mutation"),
    0x07: _policy("CMD_SEND_SELF_ADVERT", PolicyStatus.DENIED, "ambient RF transmission"),
    0x08: _policy("CMD_SET_ADVERT_NAME", PolicyStatus.DENIED, "radio identity mutation"),
    0x09: _policy(
        "CMD_ADD_UPDATE_CONTACT", PolicyStatus.DB_MUTATION, "revision-fenced existing DB contact"
    ),
    0x0A: _policy("CMD_SYNC_NEXT_MESSAGE", PolicyStatus.EXISTING, "durable per-client cursor"),
    0x0B: _policy("CMD_SET_RADIO_PARAMS", PolicyStatus.DENIED, "radio retune"),
    0x0C: _policy("CMD_SET_RADIO_TX_POWER", PolicyStatus.DENIED, "radio retune"),
    0x0D: _policy(
        "CMD_RESET_PATH", PolicyStatus.DENIED, "route mutation requires reviewed service"
    ),
    0x0E: _policy("CMD_SET_ADVERT_LATLON", PolicyStatus.DENIED, "radio identity mutation"),
    0x0F: _policy("CMD_REMOVE_CONTACT", PolicyStatus.DB_MUTATION, "DB-only removal"),
    0x10: _policy("CMD_SHARE_CONTACT", PolicyStatus.DENIED, "RF transmission"),
    0x11: _policy("CMD_EXPORT_CONTACT", PolicyStatus.DENIED, "signed advert unavailable"),
    0x12: _policy("CMD_IMPORT_CONTACT", PolicyStatus.DENIED, "no exact advert signature verifier"),
    0x13: _policy("CMD_REBOOT", PolicyStatus.DENIED, "privileged radio control"),
    0x14: _policy("CMD_GET_BATT_AND_STORAGE", PolicyStatus.DENIED, "no exact cached snapshot"),
    0x15: _policy("CMD_SET_TUNING_PARAMS", PolicyStatus.DENIED, "radio retune"),
    0x16: _policy("CMD_DEVICE_QUERY", PolicyStatus.EXISTING, "verified cached device metadata"),
    0x17: _policy("CMD_EXPORT_PRIVATE_KEY", PolicyStatus.DENIED, "secret export"),
    0x18: _policy("CMD_IMPORT_PRIVATE_KEY", PolicyStatus.DENIED, "identity replacement"),
    0x19: _policy("CMD_SEND_RAW_DATA", PolicyStatus.DENIED, "raw RF transmission"),
    0x1A: _policy("CMD_SEND_LOGIN", PolicyStatus.DENIED, "RF authentication request"),
    0x1B: _policy("CMD_SEND_STATUS_REQ", PolicyStatus.DENIED, "RF request"),
    0x1C: _policy("CMD_HAS_CONNECTION", PolicyStatus.DENIED, "no virtual connection state"),
    0x1D: _policy("CMD_LOGOUT", PolicyStatus.DENIED, "no virtual connection state"),
    0x1E: _policy("CMD_GET_CONTACT_BY_KEY", PolicyStatus.EXISTING, "durable DB contact"),
    0x1F: _policy("CMD_GET_CHANNEL", PolicyStatus.EXISTING, "stable virtual channel slot"),
    0x20: _policy("CMD_SET_CHANNEL", PolicyStatus.DENIED, "virtual slot map is operator-owned"),
    0x21: _policy("CMD_SIGN_START", PolicyStatus.DENIED, "signing oracle"),
    0x22: _policy("CMD_SIGN_DATA", PolicyStatus.DENIED, "signing oracle"),
    0x23: _policy("CMD_SIGN_FINISH", PolicyStatus.DENIED, "signing oracle"),
    0x24: _policy("CMD_SEND_TRACE_PATH", PolicyStatus.DENIED, "RF transmission"),
    0x25: _policy("CMD_SET_DEVICE_PIN", PolicyStatus.DENIED, "transport credential mutation"),
    0x26: _policy("CMD_SET_OTHER_PARAMS", PolicyStatus.DENIED, "radio configuration mutation"),
    0x27: _policy("CMD_SEND_TELEMETRY_REQ", PolicyStatus.DENIED, "RF request"),
    0x28: _policy("CMD_GET_CUSTOM_VARS", PolicyStatus.DENIED, "no exact cached snapshot"),
    0x29: _policy("CMD_SET_CUSTOM_VAR", PolicyStatus.DENIED, "radio configuration mutation"),
    0x2A: _policy("CMD_GET_ADVERT_PATH", PolicyStatus.DENIED, "firmware table is not virtualized"),
    0x2B: _policy("CMD_GET_TUNING_PARAMS", PolicyStatus.DENIED, "no exact cached snapshot"),
    0x32: _policy("CMD_SEND_BINARY_REQ", PolicyStatus.DENIED, "raw RF request"),
    0x33: _policy("CMD_FACTORY_RESET", PolicyStatus.DENIED, "destructive radio control"),
    0x34: _policy("CMD_SEND_PATH_DISCOVERY_REQ", PolicyStatus.DENIED, "RF request"),
    0x36: _policy("CMD_SET_FLOOD_SCOPE_KEY", PolicyStatus.DENIED, "radio secret mutation"),
    0x37: _policy("CMD_SEND_CONTROL_DATA", PolicyStatus.DENIED, "raw RF transmission"),
    0x38: _policy("CMD_GET_STATS", PolicyStatus.DENIED, "no exact cached snapshot"),
    0x39: _policy("CMD_SEND_ANON_REQ", PolicyStatus.DENIED, "raw RF request"),
    0x3A: _policy("CMD_SET_AUTOADD_CONFIG", PolicyStatus.DENIED, "radio contact policy mutation"),
    0x3B: _policy("CMD_GET_AUTOADD_CONFIG", PolicyStatus.DENIED, "radio-only state"),
    0x3C: _policy("CMD_GET_ALLOWED_REPEAT_FREQ", PolicyStatus.DENIED, "radio-only state"),
    0x3D: _policy("CMD_SET_PATH_HASH_MODE", PolicyStatus.DENIED, "radio configuration mutation"),
    0x3E: _policy("CMD_SEND_CHANNEL_DATA", PolicyStatus.DENIED, "unverified datagram semantics"),
    0x3F: _policy("CMD_SET_DEFAULT_FLOOD_SCOPE", PolicyStatus.DENIED, "radio secret mutation"),
    0x40: _policy("CMD_GET_DEFAULT_FLOOD_SCOPE", PolicyStatus.DENIED, "radio secret state"),
    0x41: _policy("CMD_SEND_RAW_PACKET", PolicyStatus.DENIED, "raw RF transmission"),
    0x42: _policy("CMD_RUN_CLI_COMMAND", PolicyStatus.DENIED, "arbitrary local CLI"),
}


class ContactMutationRepository:
    async def get_companion_snapshot(self, since: int = 0) -> CompanionContactSnapshot:
        return await ContactRepository.get_companion_snapshot(since)

    async def apply_companion_mutation(
        self, mutation: CompanionContactMutation
    ) -> tuple[Contact, int] | None:
        return await ContactRepository.apply_companion_mutation(mutation)

    async def delete_companion_contact(self, public_key: str) -> bool:
        return await ContactRepository.delete_companion_contact(public_key)


PushContact = Callable[[bytes], None]
Broadcast = Callable[..., None]


class VirtualCompanionCommandPolicy:
    """Implement only local time and fenced DB contact mutations."""

    def __init__(
        self,
        *,
        repository: ContactMutationRepository | None = None,
        contact_push: PushContact | None = None,
        broadcast_fn: Broadcast = broadcast_event,
        now_fn=time.time,
    ) -> None:
        self._repository = repository or ContactMutationRepository()
        self._contact_push = contact_push or (lambda _payload: None)
        self._broadcast = broadcast_fn
        self._now = now_fn

    async def get_device_time(self, _payload: bytes, _context: DispatchContext) -> bytes:
        current = min(0xFFFFFFFF, max(0, int(self._now())))
        return struct.pack("<BI", RESP_CODE_CURR_TIME, current)

    async def add_update_contact(self, payload: bytes, _context: DispatchContext) -> bytes:
        if not _identity_bound(_context):
            return _error(ERR_CODE_BAD_STATE)
        decoded = _decode_contact_mutation(payload)
        if decoded is None:
            return _error(ERR_CODE_ILLEGAL_ARG)
        snapshot = await self._repository.get_companion_snapshot(0)
        current = {
            contact.public_key.lower(): (contact, revision)
            for contact, revision in snapshot.contacts
        }.get(decoded.public_key)
        if current is None:
            # Unsigned ADD_UPDATE frames cannot establish a new trusted identity.
            return _error(ERR_CODE_NOT_FOUND)
        _contact, revision = current
        if decoded.expected_revision != revision:
            return _error(ERR_CODE_BAD_STATE)
        updated = await self._repository.apply_companion_mutation(decoded)
        if updated is None:
            return _error(ERR_CODE_BAD_STATE)
        contact, new_revision = updated
        try:
            await record_contact_name_and_reconcile(
                public_key=contact.public_key,
                contact_name=contact.name,
                timestamp=int(self._now()),
            )
        except Exception:
            logger.exception("Virtual Companion contact reconciliation failed after DB commit")
        self._emit_change(
            "contact",
            contact.model_dump(),
            encode_contact(contact, new_revision, response_code=PUSH_CODE_NEW_ADVERT),
        )
        return bytes((RESP_CODE_OK,))

    async def remove_contact(self, payload: bytes, _context: DispatchContext) -> bytes:
        if not _identity_bound(_context):
            return _error(ERR_CODE_BAD_STATE)
        public_key = payload[1:].hex()
        if not _valid_public_key(bytes.fromhex(public_key)):
            return _error(ERR_CODE_ILLEGAL_ARG)
        snapshot = await self._repository.get_companion_snapshot(0)
        if all(
            contact.public_key.lower() != public_key for contact, _revision in snapshot.contacts
        ):
            return _error(ERR_CODE_NOT_FOUND)
        if not await self._repository.delete_companion_contact(public_key):
            return _error(ERR_CODE_BAD_STATE)
        self._emit_change(
            "contact_deleted",
            {"public_key": public_key},
            bytes((PUSH_CODE_CONTACT_DELETED,)) + bytes.fromhex(public_key),
        )
        return bytes((RESP_CODE_OK,))

    def _emit_change(self, event: str, data: dict, push: bytes) -> None:
        try:
            self._broadcast(event, data)
        except Exception:
            logger.exception("Virtual Companion web contact notification failed")
        try:
            self._contact_push(push)
        except Exception:
            logger.exception("Virtual Companion TCP contact notification failed")


def register_command_policy(
    dispatcher: CommandDispatcher,
    *,
    adapter: VirtualCompanionCommandPolicy | None = None,
) -> VirtualCompanionCommandPolicy:
    """Complete the dispatcher with every source-defined command disposition."""
    adapter = adapter or VirtualCompanionCommandPolicy()
    handlers = {
        0x05: (adapter.get_device_time, 1, 1),
        0x09: (adapter.add_update_contact, 148, 148),
        0x0F: (adapter.remove_contact, 33, 33),
    }
    for command, policy in FIRMWARE_COMMAND_POLICY.items():
        if command in dispatcher.registered_commands:
            if policy.status not in {PolicyStatus.EXISTING}:
                raise ValueError(f"unexpected pre-registered command 0x{command:02x}")
            continue
        handler_spec = handlers.get(command)
        if handler_spec is not None:
            handler, min_length, max_length = handler_spec
            dispatcher.register(command, handler, min_length=min_length, max_length=max_length)
            continue
        if policy.status is not PolicyStatus.DENIED:
            raise ValueError(f"missing allowed command adapter for 0x{command:02x}")
        dispatcher.register(command, _deny, min_length=1, max_length=176)
    return adapter


async def _deny(_payload: bytes, _context: DispatchContext) -> bytes:
    return _error(ERR_CODE_UNSUPPORTED_CMD)


def _decode_contact_mutation(payload: bytes) -> CompanionContactMutation | None:
    if len(payload) != 148 or payload[0] != 0x09:
        return None
    key_bytes = payload[1:33]
    if not _valid_public_key(key_bytes):
        return None
    contact_type = payload[33]
    flags = payload[34]
    if contact_type > 4:
        return None
    path_len_byte = payload[35]
    path_block = payload[36:100]
    if path_len_byte == 0xFF:
        direct_path = None
        direct_path_len = -1
        direct_path_hash_mode = -1
        used_path_bytes = 0
    else:
        direct_path_hash_mode = path_len_byte >> 6
        direct_path_len = path_len_byte & 0x3F
        if direct_path_hash_mode > 2:
            return None
        used_path_bytes = direct_path_len * (direct_path_hash_mode + 1)
        if used_path_bytes > len(path_block):
            return None
        direct_path = path_block[:used_path_bytes].hex() or None
    if any(path_block[used_path_bytes:]):
        return None
    name_block = payload[100:132]
    name_bytes, separator, padding = name_block.partition(b"\0")
    if not separator or any(padding):
        return None
    try:
        name = name_bytes.decode("utf-8")
    except UnicodeDecodeError:
        return None
    lat, lon, revision = struct.unpack("<iiI", payload[136:148])
    if not -90_000_000 <= lat <= 90_000_000 or not -180_000_000 <= lon <= 180_000_000:
        return None
    return CompanionContactMutation(
        public_key=key_bytes.hex(),
        expected_revision=revision,
        name=name,
        contact_type=contact_type,
        flags=flags,
        favorite=bool(flags & 0x01),
        direct_path=direct_path,
        direct_path_len=direct_path_len,
        direct_path_hash_mode=direct_path_hash_mode,
    )


def _valid_public_key(value: bytes) -> bool:
    return len(value) == 32 and value not in {bytes(32), bytes([0xFF]) * 32}


def _identity_bound(context: DispatchContext) -> bool:
    value = context.identity_public_key
    if context.identity_generation is None or value is None or len(value) != 64:
        return False
    try:
        return _valid_public_key(bytes.fromhex(value))
    except ValueError:
        return False


def _error(code: int) -> bytes:
    return bytes((RESP_CODE_ERR, code))
