"""Pinned meshcore 2.3.14 Companion push compatibility, without RF hardware."""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import patch

import pytest
from meshcore.events import Event, EventType

from app.event_handlers import (
    on_radio_contact_deleted,
    on_radio_contacts_full,
    register_event_handlers,
)
from app.models import ContactUpsert
from app.repository.contacts import ContactRepository
from app.services.contact_residency import note_confirmed_radio_contact

KEY = "AB" * 32
OTHER_KEY = "CD" * 32


@pytest.mark.asyncio
async def test_eviction_only_clears_radio_residency_and_preserves_app_contact(test_db):
    mc = object()
    runtime = SimpleNamespace(meshcore=mc, radio_generation=9)
    with patch("app.services.radio_runtime.radio_runtime", runtime):
        await ContactRepository.upsert(
            ContactUpsert(
                public_key=KEY.lower(),
                name="saved",
                on_radio=True,
                type=2,
            )
        )
        await ContactRepository.upsert(
            ContactUpsert(public_key=OTHER_KEY.lower(), on_radio=True, name="other")
        )
        sent = []
        with patch(
            "app.event_handlers.broadcast_event",
            side_effect=lambda kind, payload: sent.append((kind, payload)),
        ):
            await on_radio_contact_deleted(
                Event(EventType.CONTACT_DELETED, {"pubkey": KEY.lower()}),
                generation=9,
                source=mc,
            )
        contact = await ContactRepository.get_by_key(KEY.lower())
        other = await ContactRepository.get_by_key(OTHER_KEY.lower())
        assert contact is not None and contact.name == "saved" and contact.on_radio is False
        assert other is not None and other.on_radio is True
        assert sent and sent[-1][0] == "contact"
        assert sent[-1][1]["public_key"] == KEY.lower()
        assert sent[-1][1]["on_radio"] is False


@pytest.mark.asyncio
async def test_malformed_unknown_and_readded_contact_not_demoted(test_db):
    runtime = SimpleNamespace(meshcore=object(), radio_generation=17)
    with patch("app.services.radio_runtime.radio_runtime", runtime):
        await ContactRepository.upsert(ContactUpsert(public_key=KEY.lower(), on_radio=True))
        for value in ("aabb", "gg" * 32, None, "CC" * 31):
            await on_radio_contact_deleted(Event(EventType.CONTACT_DELETED, {"pubkey": value}))
        await on_radio_contact_deleted(Event(EventType.CONTACT_DELETED, {"pubkey": "DD" * 32}))
        await on_radio_contact_deleted(
            Event(EventType.CONTACT_DELETED, {"pubkey": KEY.lower()}), generation=16
        )
        assert (await ContactRepository.get_by_key(KEY.lower())).on_radio is True

        # Callback received earlier than a later authoritative radio re-add.
        import time

        old_notification_at = time.monotonic() - 10
        note_confirmed_radio_contact(KEY.lower(), 17)
        await on_radio_contact_deleted(
            Event(EventType.CONTACT_DELETED, {"pubkey": KEY.lower()}),
            generation=17,
            received_at=old_notification_at,
        )
        assert (await ContactRepository.get_by_key(KEY.lower())).on_radio is True


@pytest.mark.asyncio
async def test_contacts_full_rate_limited_and_no_database_writes(test_db):
    runtime = SimpleNamespace(meshcore=object(), radio_generation=19)
    import app.event_handlers as handlers

    handlers._last_contacts_full_warning = None
    with patch("app.services.radio_runtime.radio_runtime", runtime):
        with patch("app.websocket.broadcast_error") as errors:
            for _ in range(12):
                await on_radio_contacts_full(Event(EventType.CONTACTS_FULL, {}), generation=19)
            errors.assert_called_once()
            assert "manually" in errors.call_args.args[1]
        runtime.radio_generation = 20
        with patch("app.websocket.broadcast_error") as errors:
            await on_radio_contacts_full(Event(EventType.CONTACTS_FULL, {}), generation=20)
            errors.assert_called_once()


def test_sdk_registers_both_companion_push_handlers():
    assert EventType.CONTACT_DELETED.value == "contact_deleted"
    assert EventType.CONTACTS_FULL.value == "contacts_full"
    active = {}

    class Subscription:
        def unsubscribe(self):
            pass

    class Radio:
        def subscribe(self, event_type, handler):
            active[event_type] = handler
            return Subscription()

    mock_mc = Radio()
    with patch(
        "app.services.radio_runtime.radio_runtime",
        SimpleNamespace(meshcore=mock_mc, radio_generation=3),
    ):
        register_event_handlers(mock_mc)
    assert EventType.CONTACT_DELETED in active
    assert EventType.CONTACTS_FULL in active
