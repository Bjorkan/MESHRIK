from unittest.mock import AsyncMock, MagicMock

import pytest
from meshcore import EventType

import app.radio_sync as radio_sync
from app.radio import radio_manager
from app.repository import ChannelRepository


@pytest.mark.asyncio
async def test_reused_channel_slot_never_rewrites_mismatched_db_identity(test_db):
    from app.services import pending_radio_ingress

    key_a, key_b = "aa" * 16, "bb" * 16
    await ChannelRepository.upsert(key=key_a, name="#original", on_radio=False)
    mc = MagicMock()
    current = MagicMock(type=EventType.CHANNEL_INFO)
    current.payload = {"channel_name": "#replacement", "channel_secret": bytes.fromhex(key_b)}
    mc.commands.get_channel = AsyncMock(return_value=current)
    ok = await radio_sync._store_pending_channel_message(
        mc,
        {
            "channel_idx": 4,
            "verified_channel_key": key_a,
            "sender_timestamp": 1700000000,
            "text": "secret message",
        },
    )
    assert ok is False
    assert await ChannelRepository.get_by_key(key_b) is None
    assert (await ChannelRepository.get_by_key(key_a)).name == "#original"
    assert radio_manager.get_pending_message_channel_key(4) != key_b.upper()
    unresolved = await pending_radio_ingress.unresolved()
    assert len(unresolved) == 1 and unresolved[0][1] == "CHAN"
