"""Hardware-free MeshCore Companion protocol 13 vs 14 compatibility fixtures."""

import json
from pathlib import Path
from unittest.mock import AsyncMock

import pytest
from meshcore.commands.messaging import MessagingCommands
from meshcore.events import Event, EventDispatcher, EventType
from meshcore.packets import CommandType, PacketType, TxtType
from meshcore.reader import MessageReader

FIXTURE = json.loads(
    (Path(__file__).parent / "fixtures/meshcore_companion_protocol_118.json").read_text()
)


def test_sdk_knows_protocol_14_and_binary_extensions():
    modern = FIXTURE["companion_118"]
    assert CommandType.RUN_CLI_COMMAND.value == modern["local_cli_command"]
    assert PacketType.CLI_REPLY.value == modern["local_cli_reply"]
    assert TxtType.CLI_CMD.value == modern["remote_cli_txt_type"]
    assert PacketType.CHANNEL_DATA_RECV.value == modern["channel_data_reply"]
    assert CommandType.SEND_CHANNEL_DATA.value == modern["channel_data_command"]
    assert FIXTURE["legacy"]["get_pending_message"] == 10


@pytest.mark.asyncio
async def test_sdk_decodes_cli_reply_fixture():
    dispatcher = AsyncMock()
    reader = MessageReader(dispatcher)
    await reader.handle_rx(bytearray.fromhex(FIXTURE["sample_frames"]["cli_reply"]))
    assert dispatcher.dispatch.await_count == 1
    event = dispatcher.dispatch.call_args.args[0]
    assert event.type == EventType.CLI_REPLY
    assert event.payload["text"] == "> on"


@pytest.mark.asyncio
async def test_sdk_fetch_waiter_consumes_channel_data():
    dispatcher = EventDispatcher()
    await dispatcher.start()
    reader = MessageReader(dispatcher)
    cmd = MessagingCommands()
    cmd.dispatcher = dispatcher

    async def simulate_radio(command):
        assert command == bytes([FIXTURE["legacy"]["get_pending_message"]])
        await reader.handle_rx(bytearray.fromhex(FIXTURE["sample_frames"]["channel_data_direct"]))

    cmd._sender_func = simulate_radio
    try:
        event = await cmd.get_msg(timeout=1)
        assert event.type == EventType.CHANNEL_DATA_RECV
        assert event.payload["SNR"] == -1
        assert event.payload["data_type"] == 0x0123
        assert event.payload["payload"] == "deadbeef"
    finally:
        await dispatcher.stop()


@pytest.mark.asyncio
async def test_sdk_binary_flood_command_fixture():
    cmd = MessagingCommands()
    cmd.send = AsyncMock(return_value=Event(EventType.OK, {}))
    await cmd.send_channel_data(1, 0xFFFF, bytes.fromhex("a1b2c3"))
    sent, replies = cmd.send.call_args.args
    assert sent.hex() == FIXTURE["sample_frames"]["channel_data_flood_tx"]
    assert replies == [EventType.OK, EventType.ERROR]


def test_protocol_13_local_cli_is_capability_gated():
    from app.services.companion_cli import SAFE_LOCAL_COMMANDS

    assert "set radio 100" not in SAFE_LOCAL_COMMANDS
    assert FIXTURE["legacy"]["firmware_protocol"] < FIXTURE["companion_118"]["firmware_protocol"]
