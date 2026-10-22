"""S09 stable virtual-slot channel sends through the canonical worker."""

import asyncio
import inspect
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest
from fastapi import HTTPException
from meshcore import EventType

from app.models import Channel, Message
from app.radio import RadioOperationBusyError
from app.repository.channels import ChannelRepository, CompanionChannelRecord
from app.repository.messages import MessageRepository
from app.services.message_send import SCOPE_UNSET
from app.services.virtual_companion.channel_send import (
    VirtualCompanionChannelSender,
    decode_channel_send,
)
from app.services.virtual_companion.channels import VirtualCompanionChannels
from app.services.virtual_companion.session import SessionState

KEY_A = "11" * 16
KEY_B = "22" * 16
IDENTITY = "aa" * 32


def _command(
    text="hello",
    *,
    txt_type=0,
    index=0,
    timestamp=0x10203040,
):
    return bytes((0x03, txt_type, index)) + timestamp.to_bytes(4, "little") + text.encode("utf-8")


def _context(generation=1):
    return SessionState(identity_generation=generation, identity_public_key=IDENTITY)


class SlotRepository:
    def __init__(self, channels):
        self.channels = channels

    async def get_companion_channel(self, key):
        return self.channels.get(key.upper())


class FullChannelRepository:
    def __init__(self, channels):
        self.channels = channels

    async def get_by_key(self, key):
        return self.channels.get(key.upper())


class FakeMessages:
    def __init__(self):
        self.existing = None
        self.reservations = {}

    async def get_companion_outgoing_channel(self, _key, _text, _timestamp):
        return self.existing

    @staticmethod
    def _reservation_key(kwargs):
        return (
            kwargs["identity_key"],
            kwargs["virtual_index"],
            kwargs["sender_timestamp"],
            kwargs["text_hash"],
        )

    async def reserve_companion_channel_send(self, **kwargs):
        key = self._reservation_key(kwargs)
        if key in self.reservations:
            return False
        self.reservations[key] = "pending"
        return True

    async def finish_companion_channel_send(self, **kwargs):
        self.reservations[self._reservation_key(kwargs)] = kwargs["status"]

    async def release_companion_channel_send(self, **kwargs):
        self.reservations.pop(self._reservation_key(kwargs), None)


class FakeRuntime:
    def __init__(self):
        self.require_connected = Mock()


def _adapter(
    *,
    slots=(KEY_A,),
    slot_records=None,
    full_records=None,
    messages=None,
    send_service=None,
    runtime=None,
):
    if slot_records is None:
        slot_records = {
            KEY_A: CompanionChannelRecord(KEY_A, "Alpha"),
            KEY_B: CompanionChannelRecord(KEY_B, "Beta"),
        }
    if full_records is None:
        full_records = {
            KEY_A: Channel(key=KEY_A, name="Alpha"),
            KEY_B: Channel(key=KEY_B, name="Beta"),
        }
    channels = VirtualCompanionChannels(
        slots,
        capacity=len(slots),
        repository=SlotRepository(slot_records),
    )
    return VirtualCompanionChannelSender(
        channels,
        channel_repository=FullChannelRepository(full_records),
        message_repository=messages or FakeMessages(),
        runtime=runtime or FakeRuntime(),
        send_service=send_service
        or AsyncMock(
            return_value=Message(
                id=1,
                type="CHAN",
                conversation_key=KEY_A,
                text="Node: hello",
                sender_timestamp=0x10203040,
                received_at=1,
                outgoing=True,
            )
        ),
        broadcast_fn=Mock(),
        error_broadcast_fn=Mock(),
        now_fn=lambda: 100,
    )


@pytest.mark.parametrize(
    "payload,expected",
    [
        (_command("å", index=7), (0, 7, 0x10203040, "å")),
        (_command("hello", txt_type=1), (1, 0, 0x10203040, "hello")),
    ],
)
def test_golden_channel_command_decode(payload, expected):
    assert decode_channel_send(payload) == expected


@pytest.mark.parametrize(
    "payload",
    [
        b"\x03" * 7,
        _command("")[:-1],
        _command("hello") + b"\xff",
        _command("hello\0hidden"),
        b"\x02" + _command()[1:],
        _command("x" * 170),
    ],
)
def test_empty_malformed_utf8_nul_and_oversize_frames_are_rejected(payload):
    assert decode_channel_send(payload) is None


def test_multibyte_utf8_is_bounded_by_encoded_frame_bytes():
    boundary_text = "å" * 84 + "a"
    assert len(boundary_text.encode("utf-8")) == 169
    assert decode_channel_send(_command(boundary_text)) == (
        0,
        0,
        0x10203040,
        boundary_text,
    )
    assert decode_channel_send(_command(boundary_text + "b")) is None


@pytest.mark.asyncio
async def test_valid_send_returns_ok_and_uses_key_not_virtual_index_as_physical_slot():
    service = AsyncMock(return_value=SimpleNamespace(id=4))
    adapter = _adapter(slots=(None, None, KEY_A), send_service=service)
    response = await adapter.send_channel(_command(index=2), _context())
    assert response == b"\x00"
    kwargs = service.await_args.kwargs
    assert kwargs["channel_key_upper"] == KEY_A
    assert kwargs["key_bytes"] == bytes.fromhex(KEY_A)
    assert kwargs["temp_radio_slot"] == 0
    assert kwargs["requested_sender_timestamp"] == 0x10203040
    assert kwargs["strict_sender_timestamp"] is True
    assert kwargs["flood_scope_override"] is SCOPE_UNSET


@pytest.mark.asyncio
async def test_invalid_type_index_deleted_and_remapped_slots_never_reach_send_service():
    service = AsyncMock(return_value=SimpleNamespace(id=1))
    adapter = _adapter(send_service=service)
    assert await adapter.send_channel(_command(txt_type=1), _context()) == b"\x01\x01"
    assert await adapter.send_channel(_command(index=1), _context()) == b"\x01\x02"
    assert await adapter.send_channel(_command(), SessionState()) == b"\x01\x04"

    deleted = _adapter(slot_records={}, send_service=service)
    assert await deleted.send_channel(_command(), _context()) == b"\x01\x02"
    stale_full = _adapter(
        full_records={KEY_A: Channel(key=KEY_B, name="wrong")}, send_service=service
    )
    assert await stale_full.send_channel(_command(), _context()) == b"\x01\x02"
    assert service.await_count == 0


@pytest.mark.asyncio
async def test_concurrent_clients_and_reconnect_send_once():
    started = asyncio.Event()
    release = asyncio.Event()
    calls = 0

    async def service(**_kwargs):
        nonlocal calls
        calls += 1
        started.set()
        await release.wait()
        return SimpleNamespace(id=1)

    adapter = _adapter(send_service=service)
    tasks = [asyncio.create_task(adapter.send_channel(_command(), _context())) for _ in range(2)]
    await started.wait()
    release.set()
    assert await asyncio.gather(*tasks) == [b"\x00", b"\x00"]
    assert await adapter.send_channel(_command(), _context()) == b"\x00"
    assert calls == 1


@pytest.mark.asyncio
async def test_durable_index_identity_blocks_replay_after_virtual_slot_remap():
    messages = FakeMessages()
    first_service = AsyncMock(return_value=SimpleNamespace(id=1))
    first = _adapter(slots=(KEY_A,), messages=messages, send_service=first_service)
    assert await first.send_channel(_command(), _context()) == b"\x00"

    remapped_service = AsyncMock(return_value=SimpleNamespace(id=2))
    remapped = _adapter(slots=(KEY_B,), messages=messages, send_service=remapped_service)
    assert await remapped.send_channel(_command(), _context()) == b"\x01\x04"
    remapped_service.assert_not_awaited()


@pytest.mark.asyncio
async def test_same_text_and_timestamp_on_distinct_virtual_indices_remain_distinct():
    messages = FakeMessages()
    service = AsyncMock(return_value=SimpleNamespace(id=1))
    adapter = _adapter(slots=(KEY_A, KEY_B), messages=messages, send_service=service)
    assert await adapter.send_channel(_command(index=0), _context()) == b"\x00"
    assert await adapter.send_channel(_command(index=1), _context()) == b"\x00"
    assert service.await_count == 2


@pytest.mark.asyncio
async def test_idempotency_never_crosses_radio_identity():
    messages = FakeMessages()
    service = AsyncMock(return_value=SimpleNamespace(id=1))
    adapter = _adapter(messages=messages, send_service=service)
    assert await adapter.send_channel(_command(), _context()) == b"\x00"
    other_identity = SessionState(
        identity_generation=1,
        identity_public_key="bb" * 32,
    )
    assert await adapter.send_channel(_command(), other_identity) == b"\x00"
    assert service.await_count == 2


@pytest.mark.asyncio
async def test_queue_rejection_is_retryable_but_uncertain_result_is_not_replayed():
    busy_service = AsyncMock(side_effect=RadioOperationBusyError("full"))
    busy = _adapter(send_service=busy_service)
    assert await busy.send_channel(_command(), _context()) == b"\x01\x03"
    await asyncio.sleep(0)
    assert await busy.send_channel(_command(), _context()) == b"\x01\x03"
    assert busy_service.await_count == 2

    uncertain_service = AsyncMock(side_effect=HTTPException(408, "uncertain"))
    uncertain = _adapter(send_service=uncertain_service)
    assert await uncertain.send_channel(_command(), _context()) == b"\x01\x04"
    assert await uncertain.send_channel(_command(), _context()) == b"\x01\x04"
    assert uncertain_service.await_count == 1


@pytest.mark.asyncio
async def test_repository_idempotency_is_hashed_bounded_and_survives_new_adapter(test_db):
    await ChannelRepository.upsert(KEY_A, "Alpha")
    channels = VirtualCompanionChannels((KEY_A,), capacity=1)
    first_service = AsyncMock(return_value=SimpleNamespace(id=1))
    first = VirtualCompanionChannelSender(
        channels, runtime=FakeRuntime(), send_service=first_service
    )
    assert await first.send_channel(_command(), _context()) == b"\x00"

    second_service = AsyncMock(return_value=SimpleNamespace(id=2))
    second = VirtualCompanionChannelSender(
        channels, runtime=FakeRuntime(), send_service=second_service
    )
    assert await second.send_channel(_command(), _context()) == b"\x01\x04"
    second_service.assert_not_awaited()
    async with test_db.readonly() as conn:
        async with conn.execute(
            "SELECT text_hash, status FROM virtual_companion_channel_sends"
        ) as cursor:
            rows = await cursor.fetchall()
    assert len(rows) == 1
    assert rows[0]["text_hash"] != "hello"
    assert rows[0]["status"] == "ok"

    async with test_db.tx() as conn:
        await conn.execute("UPDATE virtual_companion_channel_sends SET created_at=0")
    third_service = AsyncMock(return_value=SimpleNamespace(id=3))
    third = VirtualCompanionChannelSender(
        channels, runtime=FakeRuntime(), send_service=third_service
    )
    assert await third.send_channel(_command(timestamp=0x10203041), _context()) == b"\x00"
    async with test_db.readonly() as conn:
        async with conn.execute(
            "SELECT COUNT(*) AS count FROM virtual_companion_channel_sends"
        ) as cursor:
            assert (await cursor.fetchone())["count"] == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("reconnected", [False, True])
async def test_real_service_uses_worker_and_physical_slot_zero_not_virtual_slot(
    test_db, reconnected
):
    await ChannelRepository.upsert(KEY_A, "Alpha")
    channels = VirtualCompanionChannels((None,) * 7 + (KEY_A,), capacity=8)
    mc = SimpleNamespace(
        self_info={"name": "Node", "public_key": IDENTITY},
        commands=SimpleNamespace(
            set_channel=AsyncMock(return_value=SimpleNamespace(type=EventType.OK, payload={})),
            send_chan_msg=AsyncMock(return_value=SimpleNamespace(type=EventType.OK, payload={})),
        ),
    )

    class Runtime:
        radio_generation = 1
        path_hash_mode = 0
        path_hash_mode_supported = False
        firmware_ver_code = 14

        def __init__(self):
            self.worker_calls = 0
            self.preferred_slots = []

        def require_connected(self):
            return mc

        async def run_radio_command(self, _name, command, **_options):
            self.worker_calls += 1
            if reconnected:
                self.radio_generation += 1
            return await command(mc)

        def plan_channel_send_slot(self, _key, *, preferred_slot):
            self.preferred_slots.append(preferred_slot)
            return preferred_slot, True, None

        def note_channel_slot_loaded(self, _key, _slot):
            return None

        def note_channel_slot_used(self, _key):
            pass

        def invalidate_channel_slot(self, _slot):
            return None

        def invalidate_cached_channel_slot(self, _key):
            pass

    runtime = Runtime()
    broadcasts = []
    adapter = VirtualCompanionChannelSender(
        channels,
        runtime=runtime,
        broadcast_fn=lambda event, data, **_kwargs: broadcasts.append((event, data)),
        error_broadcast_fn=Mock(),
        now_fn=lambda: 100,
    )
    response = await adapter.send_channel(_command(index=7), _context())
    if reconnected:
        assert response == b"\x01\x04"
        mc.commands.set_channel.assert_not_awaited()
        mc.commands.send_chan_msg.assert_not_awaited()
        return
    assert response == b"\x00"
    assert runtime.worker_calls == 1
    assert runtime.preferred_slots == [0]
    assert mc.commands.set_channel.await_args.kwargs["channel_idx"] == 0
    assert mc.commands.send_chan_msg.await_args.kwargs["chan"] == 0
    assert (
        int.from_bytes(mc.commands.send_chan_msg.await_args.kwargs["timestamp"], "little")
        == 0x10203040
    )
    stored = await MessageRepository.get_companion_outgoing_channel(KEY_A, "hello", 0x10203040)
    assert stored is not None and stored.send_status == "confirmed"
    assert sum(1 for event, _data in broadcasts if event == "message") == 1


def test_handler_has_no_raw_physical_channel_command_path():
    import app.services.virtual_companion.channel_send as module

    source = inspect.getsource(module)
    assert ".commands" not in source
    assert "set_channel(" not in source
    assert "send_chan_msg(" not in source
    assert "send_channel_message_to_channel" in source
