from unittest.mock import AsyncMock, MagicMock

import pytest
from meshcore import EventType

import app.radio_sync as radio_sync


@pytest.mark.asyncio
async def test_invalid_dequeued_dm_is_quarantined_not_reported_saved(test_db):
    from app.services import pending_radio_ingress

    malformed = MagicMock(type=EventType.CONTACT_MSG_RECV)
    malformed.payload = {"pubkey_prefix": "not-hex", "text": "secret", "txt_type": 0}
    none_left = MagicMock(type=EventType.NO_MORE_MSGS, payload={})
    mc = MagicMock()
    mc.commands.get_msg = AsyncMock(side_effect=[malformed, none_left])
    stored = await radio_sync.drain_pending_messages(mc)
    assert stored == 0
    unresolved = await pending_radio_ingress.unresolved()
    assert len(unresolved) == 1
    assert unresolved[0][1] == "PRIV"


@pytest.mark.asyncio
async def test_journal_failure_after_dequeue_is_operator_visible(monkeypatch):
    from app.services import pending_radio_ingress

    async def fail_stage(*_args):
        raise OSError("database unavailable")

    broadcast = MagicMock()
    monkeypatch.setattr(pending_radio_ingress, "stage", fail_stage)
    monkeypatch.setattr(radio_sync, "broadcast_error", broadcast)
    event = MagicMock(payload={"pubkey_prefix": "aa" * 6, "text": "unique-secret-sentinel"})
    with pytest.raises(OSError):
        await radio_sync._store_pending_direct_message(event)
    assert broadcast.call_count == 1
    assert "unique-secret-sentinel" not in str(broadcast.call_args)
