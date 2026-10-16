"""Contract checks without credentials, RF transmission or an external MQTT broker.

Golden shapes: packet/status based on observer MQTT_IMPLEMENTATION.md and
host-sampled neighbor extension for Companion protocol 13 (#113). The fixture
name makes clear that the host subset is not a firmware neighbor-table export.
"""

from __future__ import annotations

import asyncio
import json
from datetime import UTC, datetime
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest
from meshcore.events import EventType
from meshcore.reader import MessageReader

from app.fanout.community_mqtt import (
    CommunityMqttPublisher,
    _format_raw_packet,
    _normalize_observer_stats,
    parse_broker_error,
)
from app.fanout.community_topics import community_topic, error_subscriptions
from app.fanout.mqtt_community import MqttCommunityModule
from app.fanout.packet_filter import admits_packet
from app.repository.observed_neighbors import build_observed_neighbors_payload

FIXTURES = Path(__file__).parent / "fixtures" / "community_mqtt"
KEY = "A1" * 32


def fixture(name: str) -> dict:
    return json.loads((FIXTURES / (name + ".json")).read_text())


def test_packet_golden_wire_shape_and_timestamp():
    expected = fixture("packet")
    received = _format_raw_packet(
        {"data": "0100AA", "timestamp": "2025-01-02T03:04:05Z"}, "observer-fixture", KEY
    )
    assert received is not None
    # Hash is intentionally implementation-calculated from the exact binary.
    expected["hash"] = received["hash"]
    assert received == expected
    assert "path" not in received and "RSSI" not in received and "SNR" not in received
    assert datetime.fromisoformat(received["timestamp"].replace("Z", "+00:00")).tzinfo == UTC


@pytest.mark.parametrize(
    "fixture_name,raw_hex,expected_path",
    [
        ("packet_direct_3hop", "0203AABBCCDDEE", ["aa", "bb", "cc"]),
        ("packet_flood", "0100AA", None),
    ],
)
def test_observer_packet_golden_direct_and_flood_shapes(
    fixture_name: str, raw_hex: str, expected_path: list[str] | None
):
    expected = fixture(fixture_name)
    received = _format_raw_packet(
        {
            "data": raw_hex,
            "timestamp": "2025-01-02T03:04:05Z",
            "snr": 7.5,
            "rssi": -101,
        },
        "observer-fixture",
        KEY,
    )

    assert received == expected
    for field in ("len", "packet_type", "payload_len", "RSSI", "SNR"):
        assert isinstance(received[field], str)
    if expected_path is None:
        assert "path" not in received
    else:
        assert received["path"] == expected_path
    assert "score" not in received


@pytest.mark.asyncio
async def test_companion_signal_bytes_and_host_rx_time_survive_queue_delay():
    dispatcher = SimpleNamespace(dispatch=AsyncMock())
    reader = MessageReader(dispatcher)

    # Companion LOG_DATA: code, signed SNR×4, signed RSSI, then untouched RF bytes.
    await reader.handle_rx(bytearray.fromhex("881E9B0100AA"))
    event = dispatcher.dispatch.await_args.args[0]
    assert event.type == EventType.RX_LOG_DATA
    assert event.payload["snr"] == 7.5  # 0x1e / 4
    assert event.payload["rssi"] == -101  # signed int8 0x9b

    host_rx_time = "2025-01-02T03:04:05Z"
    await asyncio.sleep(0)  # model fanout queue scheduling after host ingest
    packet = _format_raw_packet(
        {
            "data": event.payload["payload"],
            "timestamp": host_rx_time,
            "snr": event.payload["snr"],
            "rssi": event.payload["rssi"],
        },
        "observer-fixture",
        KEY,
    )

    assert packet == fixture("packet_flood")
    assert packet["timestamp"] == host_rx_time
    assert packet["time"] == "03:04:05"
    assert packet["date"] == "02/01/2025"
    assert "score" not in packet


def test_status_golden_shape_and_stats():
    golden = fixture("status")
    assert golden["status"] in {"online", "offline"}
    assert golden["origin_id"] == KEY
    assert golden["timestamp"].endswith("Z")
    assert _normalize_observer_stats({"battery_mv": 3400, "packets": {"recv": 3, "sent": 8}}) == {
        "battery_mv": 3400,
        "packets_received": 3,
        "packets_sent": 8,
    }


def test_host_sampled_neighbors_fixture_not_an_authoritative_radio_table():
    golden = fixture("neighbors")
    assert golden["sample_type"] == "host_observed_nearby"
    assert "scopes" not in golden["self"]
    assert all(len(row["pubkey"]) == 64 for row in golden["neighbors"])
    sample = build_observed_neighbors_payload(
        [
            {
                "public_key": "b2" * 32,
                "local_snr": 2.5,
                "last_seen": 9,
                "scope_status": "responded",
                "scope_names": '["RegionA"]',
            },
            {
                "public_key": "c3" * 32,
                "local_snr": None,
                "last_seen": 9,
                "scope_status": "not_queried",
                "scope_names": None,
            },
            {"public_key": "b2", "last_seen": 10},  # prefix-only identity: never publish
        ],
        "observer-fixture",
        KEY,
        now=19,
    )
    assert sample["total_neighbors"] == 2
    assert sample["queried_neighbors"] == 1
    assert "scopes" not in sample["self"]
    assert sample["neighbors"][0]["pubkey"] == "B2" * 32


@pytest.mark.parametrize(
    "profile,expected",
    [
        ({"profile": "letsmesh", "iata": "ARN"}, "meshcore/ARN/"),
        (
            {"profile": "meshrank", "token": "PrivateTestToken_x"},
            "meshrank/uplink/PrivateTestToken_x/",
        ),
        ({"profile": "custom", "topic_template": "station/{PUBLIC_KEY}/packets"}, "station/"),
    ],
)
def test_topic_matrix_and_reserved_topic_policy(profile, expected):
    for kind in ("status", "packets", "neighbors"):
        topic = community_topic(profile, KEY, kind)
        assert topic.startswith(expected)
        assert topic.endswith("/" + kind)
        assert KEY in topic
    for reserved in ("raw", "error", "internal", "serial"):
        with pytest.raises(ValueError):
            community_topic(profile, KEY, reserved)


def test_auth_diagnostics_and_broker_error_are_sanitized():
    own = {"profile": "letsmesh", "iata": "ARN"}
    assert error_subscriptions(own, KEY) == (
        f"meshcore/ARN/{KEY}/error",
        f"meshcore/XXX/{KEY}/error",
    )
    assert error_subscriptions({"profile": "meshrank", "token": "PrivateTestToken_x"}, KEY) == ()
    source = (
        b'{"code":"PUBLISH_STALE_STATUS","message":"secret leaked?", "at":"2025-01-02T03:04:05Z"}'
    )
    parsed = parse_broker_error(source)
    assert parsed is not None and parsed[0] == "PUBLISH_STALE_STATUS"
    assert "secret" not in parsed[1]
    assert parse_broker_error(b"{not json") is None
    assert parse_broker_error(b"x" * 4097) is None
    assert parse_broker_error(b'{"code":"UNKNOWN_FUTURE_CODE"}') is not None
    assert CommunityMqttPublisher()._safe_connection_error(SimpleNamespace(rc=5)) == (
        "Authentication refused (CONNACK 5); check broker credentials"
    )


@pytest.mark.asyncio
async def test_fifo_outage_overflow_separation_and_replay_order():
    with patch("app.keystore.get_public_key", return_value=bytes.fromhex(KEY)):
        profile = {"profile": "letsmesh", "iata": "ARN", "packet_filter": "all"}
        first = MqttCommunityModule("first", profile)
        second = MqttCommunityModule("second", profile)
        for n in range(600):
            first._enqueue("topic", {"sequence": n, "timestamp": "2025-01-02T03:04:05Z"})
        assert first.queue_stats["queued"] == 512
        assert first.queue_stats["dropped"] == 88
        assert not second._packet_queue
        assert first._packet_queue[0][1]["sequence"] == 88
        first._publisher.connected = True
        first._publisher.submit_packet = AsyncMock(return_value=True)
        # Single bounded flush batch by running the worker briefly.
        import asyncio

        task = asyncio.create_task(first._flush_packets())
        await asyncio.sleep(0.08)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        submitted = first._publisher.submit_packet.await_args_list
        assert [call.args[1]["sequence"] for call in submitted] == list(range(88, 104))
        assert first._packet_queue[0][1]["sequence"] == 104
        assert first._packet_queue[0][1]["timestamp"] == "2025-01-02T03:04:05Z"


def test_companion_protocol_13_cannot_upload_an_observed_raw_tx_frame():
    # PAYLOAD_TYPE nibble is bits 2-5, independent from route bit pair.
    for route in range(4):
        frame = bytes([(4 << 2) | route]) + (b"\x00" * 4 if route in (0, 3) else b"") + b"\x00\xaf"
        assert admits_packet([4], frame)
        assert not admits_packet([2], frame)
    # The real Companion source has RX_LOG_DATA=0x88 but no verified TX raw event.
    # Explicitly leave synthetic TX fixtures in tests, not wired to radio command results.
