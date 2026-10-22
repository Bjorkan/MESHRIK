"""S10 exhaustive deny-by-default policy and DB-only contact mutations."""

import asyncio
import inspect
import struct

import pytest

from app.models import Contact
from app.repository.contacts import ContactRepository
from app.services.virtual_companion.command_policy import (
    FIRMWARE_COMMAND_POLICY,
    PolicyStatus,
    VirtualCompanionCommandPolicy,
    register_command_policy,
)
from app.services.virtual_companion.contacts import encode_contact
from app.services.virtual_companion.dispatch import CommandDispatcher
from app.services.virtual_companion.server import VirtualCompanionServer
from app.services.virtual_companion.session import SessionState

KEY_A = "11" * 32
KEY_B = "22" * 32
SOURCE_COMMANDS = {
    *range(0x01, 0x2C),
    0x32,
    0x33,
    0x34,
    0x36,
    0x37,
    0x38,
    0x39,
    0x3A,
    0x3B,
    0x3C,
    0x3D,
    0x3E,
    0x3F,
    0x40,
    0x41,
    0x42,
}
EXISTING_COMMANDS = {0x01, 0x02, 0x03, 0x04, 0x0A, 0x16, 0x1E, 0x1F}
IDENTITY = "aa" * 32


async def _existing(_payload, _context):
    return b"\x00"


def _full_dispatcher(adapter=None):
    dispatcher = CommandDispatcher()
    for command in EXISTING_COMMANDS:
        dispatcher.register(command, _existing, min_length=1, max_length=176)
    register_command_policy(dispatcher, adapter=adapter)
    return dispatcher


def _context():
    return SessionState(identity_generation=1, identity_public_key=IDENTITY)


async def _stored_frame(public_key=KEY_A, **changes):
    contact = Contact(public_key=public_key, name="Alice", type=1, flags=0x02, **changes)
    await ContactRepository.upsert(contact)
    snapshot = await ContactRepository.get_companion_snapshot()
    stored, revision = next(item for item in snapshot.contacts if item[0].public_key == public_key)
    encoded = encode_contact(stored, revision)
    return b"\x09" + encoded[1:], revision


def _rename(frame: bytes, name: str) -> bytes:
    encoded = name.encode("utf-8")
    assert len(encoded) <= 31
    return frame[:100] + encoded.ljust(32, b"\0") + frame[132:]


def test_policy_enumerates_every_source_command_once():
    assert set(FIRMWARE_COMMAND_POLICY) == SOURCE_COMMANDS
    assert all(
        policy.name.startswith("CMD_") and policy.reason
        for policy in FIRMWARE_COMMAND_POLICY.values()
    )
    dispatcher = _full_dispatcher()
    assert dispatcher.registered_commands == SOURCE_COMMANDS


@pytest.mark.asyncio
async def test_all_denied_commands_return_firmware_unsupported_without_side_effects():
    dispatcher = _full_dispatcher()
    context = SessionState()
    denied = [
        command
        for command, policy in FIRMWARE_COMMAND_POLICY.items()
        if policy.status is PolicyStatus.DENIED
    ]
    results = await asyncio.gather(
        *(dispatcher.dispatch(bytes((command,)), context) for command in denied)
    )
    assert results == [b"\x01\x01"] * len(denied)
    assert await dispatcher.dispatch(b"\xfe", context) == b"\x01\x01"


@pytest.mark.asyncio
async def test_device_time_is_an_exact_read_only_uint32_response():
    adapter = VirtualCompanionCommandPolicy(now_fn=lambda: 0x10203040)
    response = await _full_dispatcher(adapter).dispatch(b"\x05", SessionState())
    assert response == struct.pack("<BI", 0x09, 0x10203040)


@pytest.mark.asyncio
async def test_existing_contact_edit_is_revision_fenced_and_fanned_out(test_db):
    frame, _revision = await _stored_frame(
        favorite=False,
        direct_path="1234",
        direct_path_len=2,
        direct_path_hash_mode=0,
        on_radio=True,
    )
    pushes = []
    broadcasts = []
    adapter = VirtualCompanionCommandPolicy(
        contact_push=pushes.append,
        broadcast_fn=lambda event, data: broadcasts.append((event, data)),
        now_fn=lambda: 100,
    )
    dispatcher = _full_dispatcher(adapter)
    edited = bytearray(_rename(frame, "Ålice updated"))
    edited[34] |= 0x01

    assert await dispatcher.dispatch(bytes(edited), _context()) == b"\x00"
    stored = await ContactRepository.get_by_key(KEY_A)
    assert stored is not None
    assert stored.name == "Ålice updated"
    assert stored.favorite is True
    assert stored.on_radio is True
    assert stored.direct_path == "1234"
    assert broadcasts[0][0] == "contact"
    assert len(pushes) == 1 and pushes[0][0] == 0x8A

    # Replaying the old revision cannot overwrite the newer contact.
    assert await dispatcher.dispatch(bytes(edited), _context()) == b"\x01\x04"


@pytest.mark.asyncio
async def test_concurrent_stale_updates_have_one_atomic_winner(test_db):
    frame, _revision = await _stored_frame()
    dispatcher = _full_dispatcher(VirtualCompanionCommandPolicy())
    results = await asyncio.gather(
        dispatcher.dispatch(_rename(frame, "First"), _context()),
        dispatcher.dispatch(_rename(frame, "Second"), _context()),
    )
    assert sorted(results) == [b"\x00", b"\x01\x04"]
    stored = await ContactRepository.get_by_key(KEY_A)
    assert stored is not None and stored.name in {"First", "Second"}


@pytest.mark.asyncio
async def test_unknown_and_corrupt_contact_edits_never_create_identity(test_db):
    frame, _revision = await _stored_frame()
    dispatcher = _full_dispatcher()
    unknown = bytearray(frame)
    unknown[1:33] = bytes.fromhex(KEY_B)
    assert await dispatcher.dispatch(bytes(unknown), _context()) == b"\x01\x02"
    assert await ContactRepository.get_by_key(KEY_B) is None

    zero_key = bytearray(frame)
    zero_key[1:33] = bytes(32)
    assert await dispatcher.dispatch(bytes(zero_key), _context()) == b"\x01\x06"
    bad_name = bytearray(frame)
    bad_name[100:132] = b"\xff\0" + bytes(30)
    assert await dispatcher.dispatch(bytes(bad_name), _context()) == b"\x01\x06"
    dirty_path_padding = bytearray(frame)
    dirty_path_padding[99] = 1
    assert await dispatcher.dispatch(bytes(dirty_path_padding), _context()) == b"\x01\x06"

    assert await dispatcher.dispatch(frame, SessionState()) == b"\x01\x04"


@pytest.mark.asyncio
async def test_remove_is_db_only_truthful_and_race_safe(test_db):
    await _stored_frame()
    pushes = []
    broadcasts = []
    dispatcher = _full_dispatcher(
        VirtualCompanionCommandPolicy(
            contact_push=pushes.append,
            broadcast_fn=lambda event, data: broadcasts.append((event, data)),
        )
    )
    command = b"\x0f" + bytes.fromhex(KEY_A)
    results = await asyncio.gather(
        dispatcher.dispatch(command, _context()),
        dispatcher.dispatch(command, _context()),
    )
    assert sorted(results) in ([b"\x00", b"\x01\x02"], [b"\x00", b"\x01\x04"])
    assert await ContactRepository.get_by_key(KEY_A) is None
    assert len(pushes) == 1 and pushes[0] == b"\x8f" + bytes.fromhex(KEY_A)
    assert broadcasts == [("contact_deleted", {"public_key": KEY_A})]


def test_contact_mutations_have_no_physical_command_path():
    import app.services.virtual_companion.command_policy as module

    source = inspect.getsource(module)
    assert ".commands" not in source
    assert "radio_manager" not in source
    assert "run_radio_command" not in source
    assert FIRMWARE_COMMAND_POLICY[0x20].status is PolicyStatus.DENIED


def test_server_contact_notifications_are_isolated_per_client():
    class Session:
        def __init__(self, fail=False):
            self.frames = []
            self.fail = fail

        def enqueue_push(self, payload):
            if self.fail:
                raise RuntimeError("full")
            self.frames.append(payload)

        async def close(self):
            return None

    server = VirtualCompanionServer(CommandDispatcher())
    first = Session()
    second = Session()
    server._sessions.update((first, second))
    server.notify_contact_changed(b"\x8a-contact")
    assert first.frames == second.frames == [b"\x8a-contact"]
