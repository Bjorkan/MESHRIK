from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest

from app.event_handlers import on_contact_message


@pytest.mark.asyncio
@pytest.mark.parametrize("txt_type", [1, 3])
async def test_queued_cli_never_reaches_dm_context(txt_type):
    event = SimpleNamespace(
        payload={"txt_type": txt_type, "text": "secret", "pubkey_prefix": "abcd"}
    )
    with (
        patch("app.services.radio_job_worker.radio_job_scheduler.record_activity"),
        patch(
            "app.event_handlers.resolve_fallback_direct_message_context", new_callable=AsyncMock
        ) as resolve,
    ):
        await on_contact_message(event)
        resolve.assert_not_awaited()
