"""S07 durable, independent virtual Companion message queues."""

import asyncio
import inspect
from unittest.mock import Mock

import pytest

from app.fanout.manager import FanoutManager
from app.fanout.virtual_companion_tcp import VirtualCompanionTcpModule
from app.models import Contact, Message, MessagePath
from app.repository.channels import ChannelRepository
from app.repository.contacts import ContactRepository
from app.repository.messages import MessageRepository
from app.services.virtual_companion.channels import VirtualCompanionChannels
from app.services.virtual_companion.dispatch import CommandDispatcher
from app.services.virtual_companion.messages import (
    RESP_CODE_NO_MORE_MESSAGES,
    VirtualCompanionMessages,
    encode_message,
    register_message_commands,
)
from app.services.virtual_companion.server import VirtualCompanionServer
from app.services.virtual_companion.session import SessionState, VirtualCompanionSession

CONTACT_KEY = "22" * 32
SENDER_KEY = "33" * 32
CHANNEL_KEY = "44" * 16
OTHER_CHANNEL_KEY = "55" * 16


def _message(**changes) -> Message:
    values = {
        "id": 1,
        "type": "PRIV",
        "conversation_key": CONTACT_KEY,
        "text": "hello",
        "sender_timestamp": 0x10203040,
        "received_at": 123,
        "paths": [MessagePath(path="aabbccdd", path_len=2, received_at=123, snr=-2.25)],
        "txt_type": 0,
        "sender_key": None,
        "outgoing": False,
    }
    values.update(changes)
    return Message(**values)


def test_v3_and_negotiated_legacy_golden_frames_are_exact():
    direct = _message(paths=None)
    assert encode_message(direct, channel_index=None, protocol_version=14) == (
        b"\x10\x00\x00\x00"
        + bytes.fromhex(CONTACT_KEY)[:6]
        + b"\xff\x00"
        + b"\x40\x30\x20\x10hello"
    )
    assert encode_message(direct, channel_index=None, protocol_version=2) == (
        b"\x07" + bytes.fromhex(CONTACT_KEY)[:6] + b"\xff\x00" + b"\x40\x30\x20\x10hello"
    )

    channel = _message(
        type="CHAN",
        conversation_key=CHANNEL_KEY,
        text="Alice: hej",
        sender_name="Alice",
        paths=[MessagePath(path="aabbccdd", path_len=2, received_at=123, snr=-2.25)],
    )
    assert encode_message(channel, channel_index=7, protocol_version=14) == (
        b"\x11\xf7\x00\x00\x07\x42\x00\x40\x30\x20\x10hej"
    )
    assert encode_message(channel, channel_index=7, protocol_version=2) == (
        b"\x08\x07\x42\x00\x40\x30\x20\x10hej"
    )


def test_signed_sender_prefix_utf8_bounds_and_unsupported_rows():
    signed = _message(txt_type=2, signature="a1b2c3d4", text="å" * 200, sender_key=SENDER_KEY)
    encoded = encode_message(signed, channel_index=None, protocol_version=14)
    assert encoded is not None
    assert encoded[4:10] == bytes.fromhex(CONTACT_KEY)[:6]
    assert encoded[16:20] == bytes.fromhex("a1b2c3d4")
    assert len(encoded) <= 176
    encoded[20:].decode("utf-8")
    assert (
        encode_message(
            signed.model_copy(update={"signature": None}),
            channel_index=None,
            protocol_version=14,
        )
        is None
    )
    assert encode_message(_message(outgoing=True), channel_index=None, protocol_version=14) is None
    assert (
        encode_message(_message(conversation_key="abcd"), channel_index=None, protocol_version=14)
        is None
    )


class MemoryMessageRepository:
    def __init__(self, messages, history_window_start=0):
        self.messages = list(messages)
        self.history_window_start = history_window_start

    async def get_companion_initial_cursor(self, _keys, _limit):
        return self.history_window_start

    async def get_companion_message_after(self, cursor, _keys):
        return next((message for message in self.messages if message.id > cursor), None)


@pytest.mark.asyncio
async def test_two_clients_have_interleaved_independent_cursors_and_eof():
    repository = MemoryMessageRepository([_message(id=1), _message(id=2, text="second")])
    channels = VirtualCompanionChannels((CHANNEL_KEY,), capacity=1)
    adapter = VirtualCompanionMessages(channels, repository=repository)
    dispatcher = CommandDispatcher()
    register_message_commands(dispatcher, channels, adapter)
    clients = (SessionState(protocol_version=14), SessionState(protocol_version=14))

    assert (await dispatcher.dispatch(b"\x0a", clients[0])).endswith(b"hello")
    assert (await dispatcher.dispatch(b"\x0a", clients[1])).endswith(b"hello")
    assert (await dispatcher.dispatch(b"\x0a", clients[0])).endswith(b"second")
    assert await dispatcher.dispatch(b"\x0a", clients[0]) == bytes((RESP_CODE_NO_MORE_MESSAGES,))
    assert (await dispatcher.dispatch(b"\x0a", clients[1])).endswith(b"second")
    assert clients[0].message_cursor == clients[1].message_cursor == 2


@pytest.mark.asyncio
async def test_database_window_access_deletion_and_more_than_one_thousand(test_db):
    await ContactRepository.upsert(Contact(public_key=CONTACT_KEY, name="Alice", type=1))
    await ChannelRepository.upsert(CHANNEL_KEY, "Main")
    for index in range(1005):
        await MessageRepository.create(
            "PRIV", f"dm-{index}", index + 1, CONTACT_KEY, sender_timestamp=index + 1
        )
    await MessageRepository.create("CHAN", "mapped", 2000, CHANNEL_KEY, sender_timestamp=2000)
    await MessageRepository.create("CHAN", "hidden", 2001, OTHER_CHANNEL_KEY, sender_timestamp=2001)
    await MessageRepository.create(
        "PRIV", "outgoing", 2002, CONTACT_KEY, sender_timestamp=2002, outgoing=True
    )

    keys = (CHANNEL_KEY,)
    cursor = await MessageRepository.get_companion_initial_cursor(keys, 200)
    first = await MessageRepository.get_companion_message_after(cursor, keys)
    # The mapped channel row is also eligible, so the 200-row window starts
    # at DM 806 rather than counting only direct messages.
    assert first is not None and first.text == "dm-806"

    cursor = 0
    delivered = []
    while message := await MessageRepository.get_companion_message_after(cursor, keys):
        delivered.append(message)
        cursor = message.id
    assert len(delivered) == 1006
    assert delivered[-1].text == "mapped"
    deleted_id = delivered[10].id
    await MessageRepository.delete_by_id(deleted_id)
    previous = delivered[9].id
    after_delete = await MessageRepository.get_companion_message_after(previous, keys)
    assert after_delete is not None and after_delete.id == delivered[11].id


class NullWriter:
    def write(self, _data):
        pass

    async def drain(self):
        pass

    def close(self):
        pass

    async def wait_closed(self):
        pass


@pytest.mark.asyncio
async def test_burst_notifications_coalesce_and_stale_ids_are_fenced():
    dispatcher = CommandDispatcher()
    server = VirtualCompanionServer(dispatcher)
    healthy = VirtualCompanionSession(None, NullWriter(), dispatcher, outbox_size=2)
    stalled = VirtualCompanionSession(None, NullWriter(), dispatcher, outbox_size=1)
    server._sessions.update((healthy, stalled))
    for message_id in range(1, 10_001):
        server.notify_message_waiting(message_id)
    assert healthy._outbox.qsize() == stalled._outbox.qsize() == 1
    assert await healthy._next_outbound() == b"\x83"
    healthy.state.message_cursor = 10_000
    healthy._message_waiting_pending = False
    server.notify_message_waiting(9_999)
    assert healthy._outbox.empty()

    overflow = VirtualCompanionSession(None, NullWriter(), dispatcher, outbox_size=1)
    overflow.enqueue_push(b"occupied")
    server._sessions.add(overflow)
    server.notify_message_waiting(10_001)
    await asyncio.sleep(0)
    assert overflow.closed


def test_inbox_hint_bypasses_content_scope_without_carrying_content():
    module = VirtualCompanionTcpModule(
        "vc",
        {
            "bind_host": "127.0.0.1",
            "port": 0,
            "virtual_channel_capacity": 1,
            "channel_slots": [],
        },
    )
    module._server.notify_message_waiting = Mock()
    manager = FanoutManager()
    manager._modules["vc"] = (module, {"messages": "none", "raw_packets": "none"})
    event = {"id": 42, "type": "PRIV", "outgoing": False, "text": "secret"}
    manager.notify_virtual_companions(event)
    module._server.notify_message_waiting.assert_called_once_with(42)

    module._server.notify_message_waiting.reset_mock()
    manager.notify_virtual_companions({**event, "outgoing": True})
    module._server.notify_message_waiting.assert_not_called()


def test_server_message_path_has_no_physical_radio_or_sdk_drain():
    import app.services.virtual_companion.messages as message_module

    source = inspect.getsource(message_module)
    assert "radio_runtime" not in source
    assert "meshcore" not in source.lower()
    assert "get_msg" not in source
    assert "CMD_SYNC_NEXT_MESSAGE" in source
