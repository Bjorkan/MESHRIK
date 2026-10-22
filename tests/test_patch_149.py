from unittest.mock import AsyncMock, MagicMock

import pytest
from meshcore import EventType


@pytest.mark.asyncio
async def test_buffered_early_ack_is_not_consumed_on_failed_commit(monkeypatch):
    from app.services import dm_ack_persistence, dm_ack_tracker
    from app.services.message_send import _apply_direct_message_ack_tracking

    dm_ack_tracker._pending_acks.clear()
    dm_ack_tracker._buffered_acks.clear()
    try:
        dm_ack_tracker.buffer_unmatched_ack("aabbccdd")
        monkeypatch.setattr(dm_ack_persistence, "remember", AsyncMock())
        monkeypatch.setattr(dm_ack_persistence, "confirm", AsyncMock(side_effect=[None, (35, 1)]))
        radio_result = MagicMock()
        radio_result.type = EventType.MSG_SENT
        radio_result.payload = {"expected_ack": bytes.fromhex("aabbccdd")}
        broadcast = MagicMock()
        for expected in (0, 1):
            got = await _apply_direct_message_ack_tracking(
                result=radio_result,
                message_id=35,
                track_pending_ack_fn=dm_ack_tracker.track_pending_ack,
                broadcast_fn=broadcast,
            )
            assert got == expected
        assert "aabbccdd" not in dm_ack_tracker._pending_acks
        assert "aabbccdd" not in dm_ack_tracker._buffered_acks
        broadcast.assert_called_once()
    finally:
        dm_ack_tracker._pending_acks.clear()
        dm_ack_tracker._buffered_acks.clear()
