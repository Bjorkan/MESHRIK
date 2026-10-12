"""Tests for Web Push notification payload routing."""

import json

from app.push.manager import _build_payload


def test_direct_message_payload_uses_canonical_contact_path():
    payload = json.loads(
        _build_payload(
            {
                "type": "PRIV",
                "conversation_key": "AB/CD",
                "sender_name": "Alice",
                "text": "hello",
            }
        )
    )

    assert payload["url_path"] == "/contact/AB%2FCD"
    assert "url_hash" not in payload


def test_channel_message_payload_uses_canonical_channel_path():
    payload = json.loads(
        _build_payload(
            {
                "type": "CHAN",
                "conversation_key": "channel key",
                "channel_name": "#ops",
                "text": "hello room",
            }
        )
    )

    assert payload["url_path"] == "/channel/channel%20key"
    assert "url_hash" not in payload
