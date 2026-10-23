"""S05 database-backed virtual Companion contact snapshots."""

import asyncio
import inspect
import struct
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest

from app.models import Contact
from app.repository.contacts import ContactRepository
from app.services.virtual_companion.contacts import (
    PUSH_CODE_CONTACT_DELETED,
    RESP_CODE_CONTACT,
    RESP_CODE_CONTACTS_START,
    RESP_CODE_END_OF_CONTACTS,
    VirtualCompanionContacts,
    encode_contact,
    register_contact_commands,
)
from app.services.virtual_companion.dispatch import CommandDispatcher
from app.services.virtual_companion.server import VirtualCompanionServer
from app.services.virtual_companion.session import SessionState


def _contact(key_byte: int = 0x22, **changes) -> Contact:
    values = {
        "public_key": f"{key_byte:02x}" * 32,
        "name": "Alice",
        "type": 1,
        "flags": 0x0A,
        "direct_path": "12345678",
        "direct_path_len": 2,
        "direct_path_hash_mode": 1,
        "last_advert": 0x10203040,
        "lat": 57.70887,
        "lon": 11.97456,
    }
    values.update(changes)
    return Contact(**values)


def test_contact_encoder_matches_firmware_layout_exactly():
    contact = _contact(name="Ålice", favorite=True)
    expected = bytearray((RESP_CODE_CONTACT,))
    expected.extend(bytes([0x22]) * 32)
    expected.extend((1, 0x0B, 0x42))
    expected.extend(bytes.fromhex("12345678").ljust(64, b"\0"))
    expected.extend("Ålice".encode().ljust(32, b"\0"))
    expected.extend(struct.pack("<IiiI", 0x10203040, 57_708_870, 11_974_560, 99))
    encoded = encode_contact(contact, 99)
    assert encoded == bytes(expected)
    assert len(encoded) == 148


@pytest.mark.parametrize(
    "mode,path,hops,expected",
    [
        (-1, None, -1, 0xFF),
        (0, "0102", 2, 0x02),
        (1, "01020304", 2, 0x42),
        (2, "010203040506", 2, 0x82),
    ],
)
@pytest.mark.parametrize("contact_type", [0, 1, 2, 3, 4])
def test_all_contact_types_and_path_hash_modes_encode(mode, path, hops, expected, contact_type):
    encoded = encode_contact(
        _contact(
            type=contact_type,
            direct_path=path,
            direct_path_len=hops,
            direct_path_hash_mode=mode,
        ),
        1,
    )
    assert encoded[33] == contact_type
    assert encoded[35] == expected


@pytest.mark.asyncio
async def test_zero_one_and_more_than_one_thousand_contacts(test_db):
    adapter = VirtualCompanionContacts()
    context = SessionState()
    empty = await adapter.get_contacts(b"\x04", context)
    assert len(empty) == 2
    assert empty[0] == struct.pack("<BI", RESP_CODE_CONTACTS_START, 0)
    assert empty[-1][0] == RESP_CODE_END_OF_CONTACTS

    await ContactRepository.upsert(_contact())
    one = await adapter.get_contacts(b"\x04", context)
    assert len(one) == 3
    assert one[0] == struct.pack("<BI", RESP_CODE_CONTACTS_START, 1)
    assert one[1][0] == RESP_CODE_CONTACT

    rows = [
        (f"{index:064x}", f"Contact {index}", 1, 0)
        for index in range(1, 1002)
        if index != int.from_bytes(bytes([0x22]) * 32, "big")
    ]
    async with test_db.tx() as conn:
        await conn.executemany(
            "INSERT OR IGNORE INTO contacts(public_key, name, type, flags) VALUES (?, ?, ?, ?)",
            rows,
        )
    many = await adapter.get_contacts(b"\x04", context)
    assert int.from_bytes(many[0][1:], "little") == 1002
    assert len(many) == 1004
    assert many[-1][0] == RESP_CODE_END_OF_CONTACTS


@pytest.mark.asyncio
async def test_snapshots_are_isolated_and_incremental_deletes_are_durable(test_db):
    alice = _contact(0x11, name="Alice")
    bob = _contact(0x22, name="Bob")
    await ContactRepository.upsert(alice)
    await ContactRepository.upsert(bob)
    adapter = VirtualCompanionContacts()

    first_a = await adapter.get_contacts(b"\x04", SessionState())
    first_b = await adapter.get_contacts(b"\x04", SessionState())
    assert first_a == first_b
    since = int.from_bytes(first_a[-1][1:], "little")

    await ContactRepository.upsert(_contact(0x11, name="Alice updated"))
    await ContactRepository.delete(bob.public_key)
    await ContactRepository.upsert(_contact(0x33, name="Carol"))

    incremental_b = await adapter.get_contacts(
        b"\x04" + since.to_bytes(4, "little"), SessionState()
    )
    assert first_a == first_b  # the earlier client snapshot did not mutate
    assert int.from_bytes(incremental_b[0][1:], "little") == 2
    assert [frame[0] for frame in incremental_b] == [
        RESP_CODE_CONTACTS_START,
        RESP_CODE_CONTACT,
        RESP_CODE_CONTACT,
        PUSH_CODE_CONTACT_DELETED,
        RESP_CODE_END_OF_CONTACTS,
    ]
    assert incremental_b[-2][1:] == bytes.fromhex(bob.public_key)
    assert int.from_bytes(incremental_b[-1][1:], "little") > since

    # A reconnect with the same durable cursor observes exactly the same changes.
    assert (
        await adapter.get_contacts(b"\x04" + since.to_bytes(4, "little"), SessionState())
        == incremental_b
    )


@pytest.mark.asyncio
async def test_incremental_snapshot_withholds_invalid_tombstones(test_db):
    await ContactRepository.upsert(_contact())
    before = await ContactRepository.get_companion_snapshot()
    async with test_db.tx() as conn:
        await conn.executemany(
            "INSERT INTO contacts(public_key, name, type) VALUES (?, ?, 1)",
            [("abcd", "Prefix"), ("zz" * 32, "Malformed")],
        )
    snapshot = await ContactRepository.get_companion_snapshot(before.high_water)
    assert snapshot.deleted_public_keys == ()
    assert snapshot.contacts == ()
    assert snapshot.high_water > before.high_water


@pytest.mark.asyncio
async def test_web_delete_becomes_tombstone_without_a_radio_call(test_db, client):
    contact = _contact(0x44)
    await ContactRepository.upsert(contact)
    before = await ContactRepository.get_companion_snapshot()
    radio = SimpleNamespace(is_connected=False, run_radio_command=AsyncMock())
    with (
        patch("app.routers.contacts.radio_manager", radio),
        patch("app.websocket.broadcast_event"),
    ):
        response = await client.delete(f"/api/contacts/{contact.public_key}")
    assert response.status_code == 200
    incremental = await ContactRepository.get_companion_snapshot(before.high_water)
    assert incremental.deleted_public_keys == (contact.public_key,)
    radio.run_radio_command.assert_not_awaited()


@pytest.mark.asyncio
async def test_prefix_malformed_and_case_duplicate_keys_are_withheld(test_db):
    async with test_db.tx() as conn:
        await conn.executemany(
            "INSERT INTO contacts(public_key, name, type) VALUES (?, ?, 1)",
            [
                ("abcd", "Prefix"),
                ("zz" * 32, "Malformed"),
                ("ab" * 32, "Duplicate lower"),
                ("AB" * 32, "Duplicate upper"),
                ("cd" * 32, "Valid"),
            ],
        )
    snapshot = await ContactRepository.get_companion_snapshot()
    assert snapshot.total == 1
    assert [contact.public_key.lower() for contact, _revision in snapshot.contacts] == ["cd" * 32]


@pytest.mark.asyncio
async def test_get_by_key_and_malformed_since_are_protocol_exact(test_db):
    contact = _contact(0x55)
    await ContactRepository.upsert(contact)
    dispatcher = CommandDispatcher()
    register_contact_commands(dispatcher)
    context = SessionState()
    found = await dispatcher.dispatch(b"\x1e" + bytes.fromhex(contact.public_key), context)
    assert isinstance(found, bytes) and found[0] == RESP_CODE_CONTACT
    assert await dispatcher.dispatch(b"\x1e" + bytes(32), context) == b"\x01\x02"
    assert await dispatcher.dispatch(b"\x04\x00", context) == b"\x01\x06"


@pytest.mark.asyncio
async def test_get_by_key_uses_index_and_rejects_ambiguous_identity(test_db):
    target = _contact(0xAB)
    rows = [(f"{index:064x}", f"Contact {index}", 1) for index in range(1, 1002)]
    async with test_db.tx() as conn:
        await conn.executemany(
            "INSERT INTO contacts(public_key, name, type) VALUES (?, ?, ?)", rows
        )
    await ContactRepository.upsert(target)

    result = await ContactRepository.get_companion_contact_by_key(target.public_key.upper())
    assert result is not None
    contact, revision = result
    assert contact.public_key == target.public_key
    assert revision > 0

    async with test_db.readonly() as conn:
        async with conn.execute(
            "EXPLAIN QUERY PLAN SELECT * FROM contacts WHERE lower(public_key) = ?",
            (target.public_key,),
        ) as cursor:
            plan = " ".join(str(column) for row in await cursor.fetchall() for column in row)
    assert "idx_contacts_public_key_lower" in plan

    async with test_db.tx() as conn:
        await conn.execute(
            "INSERT INTO contacts(public_key, name, type) VALUES (?, ?, 1)",
            (target.public_key.upper(), "Ambiguous"),
        )
    assert await ContactRepository.get_companion_contact_by_key(target.public_key) is None


@pytest.mark.asyncio
async def test_get_by_key_does_not_load_full_snapshot(test_db):
    target = _contact(0x66)
    await ContactRepository.upsert(target)
    repository = SimpleNamespace(
        get_companion_contact_by_key=AsyncMock(
            return_value=await ContactRepository.get_companion_contact_by_key(target.public_key)
        ),
        get_companion_snapshot=AsyncMock(side_effect=AssertionError("full snapshot requested")),
    )
    adapter = VirtualCompanionContacts(repository)

    response = await adapter.get_contact_by_key(
        b"\x1e" + bytes.fromhex(target.public_key), SessionState()
    )

    assert response[0] == RESP_CODE_CONTACT
    repository.get_companion_contact_by_key.assert_awaited_once_with(target.public_key)
    repository.get_companion_snapshot.assert_not_awaited()


def test_contact_read_path_has_no_physical_radio_or_worker_call():
    source = "\n".join(
        (
            inspect.getsource(VirtualCompanionContacts),
            inspect.getsource(ContactRepository.get_companion_snapshot),
        )
    )
    assert "radio_manager" not in source
    assert ".commands" not in source
    assert "run_radio_command" not in source


@pytest.mark.asyncio
async def test_two_large_streams_use_independent_bounded_session_queues(test_db):
    async with test_db.tx() as conn:
        await conn.executemany(
            "INSERT INTO contacts(public_key, name, type) VALUES (?, ?, 1)",
            [(f"{index:064x}", str(index)) for index in range(1100)],
        )
    dispatcher = CommandDispatcher()
    register_contact_commands(dispatcher)
    server = VirtualCompanionServer(dispatcher)
    await server.start("127.0.0.1", 0)
    port = server.sockets[0].getsockname()[1]
    reader_a, writer_a = await asyncio.open_connection("127.0.0.1", port)
    reader_b, writer_b = await asyncio.open_connection("127.0.0.1", port)

    async def request_all(reader, writer):
        writer.write(b"<\x01\x00\x04")
        await writer.drain()
        frames = []
        while not frames or frames[-1][0] != RESP_CODE_END_OF_CONTACTS:
            header = await reader.readexactly(3)
            assert header[0] == ord(">")
            frames.append(await reader.readexactly(int.from_bytes(header[1:], "little")))
        return frames

    try:
        results = await asyncio.gather(
            request_all(reader_a, writer_a), request_all(reader_b, writer_b)
        )
        assert results[0] == results[1]
        assert len(results[0]) == 1102
        assert server.client_count == 2
    finally:
        writer_a.close()
        writer_b.close()
        await asyncio.gather(writer_a.wait_closed(), writer_b.wait_closed())
        await server.stop()
