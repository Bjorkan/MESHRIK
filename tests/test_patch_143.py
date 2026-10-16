from unittest.mock import AsyncMock, MagicMock

import pytest


@pytest.mark.asyncio
async def test_ambiguous_dm_retry_never_automatically_retransmits(monkeypatch):
    from types import SimpleNamespace

    from app.services import message_send

    contact = SimpleNamespace(public_key="aa" * 32, to_radio_dict=lambda: {"key": "aa"})
    repo = MagicMock()
    repo.get_ack_and_paths = AsyncMock(return_value=(0, None))
    repo.update_send_status = AsyncMock()
    attempted = 0

    async def fake_radio_command(_manager, _name, callback):
        nonlocal attempted
        attempted += 1
        raise TimeoutError("Companion reply lost after send")

    monkeypatch.setattr(message_send, "_run_radio_command", fake_radio_command)
    monkeypatch.setattr(message_send, "DM_SEND_MAX_ATTEMPTS", 3)

    async def fake_sleep(_seconds):
        pass

    await message_send._retry_direct_message_until_acked(
        contact=contact,
        text="sentinel",
        message_id=90,
        sender_timestamp=1700000000,
        radio_manager=MagicMock(),
        track_pending_ack_fn=MagicMock(),
        broadcast_fn=MagicMock(),
        wait_timeout_ms=10,
        sleep_fn=fake_sleep,
        message_repository=repo,
    )
    assert attempted == 1
    repo.update_send_status.assert_awaited_once_with(90, "unknown")
