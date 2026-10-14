"""No hardware or credentials: observer packet wire contract fixtures (#110)."""
from datetime import UTC, datetime

import pytest

from app.fanout.community_mqtt import _format_raw_packet


@pytest.mark.parametrize("mode,width", [(0, 1), (1, 2), (2, 3)])
def test_exact_multibyte_direct_hop_widths(mode: int, width: int):
    hops = (bytes(range(width)), bytes(range(width, 2 * width)))
    packet = bytes([0x0A, (mode << 6) | 2]) + b"".join(hops) + b"\x22"
    result = _format_raw_packet({"data": packet.hex(), "timestamp": 1_700_000_000}, "rx", "aa" * 32)
    assert result is not None
    assert result["path"] == [hop.hex() for hop in hops]
    assert result["raw"] == packet.hex().upper()


def test_transport_direct_and_preserved_host_ingest_timestamp():
    packet = "130000000001eeff"
    result = _format_raw_packet({"data": packet, "timestamp": "2024-03-30T23:15:06-05:00"}, "rx", "bb" * 32)
    assert result is not None
    assert result["timestamp"] == "2024-03-31T04:15:06Z"
    assert result["time"] == "04:15:06"
    assert result["date"] == "31/03/2024"
    assert result["path"] == ["ee"]
    assert result["route"] == "T"


def test_invalid_bytes_metrics_and_flood_without_path():
    assert _format_raw_packet({"data": "not hex"}, "node", "aa" * 32) is None
    result = _format_raw_packet({"data": "0100AA", "timestamp": datetime(2025, 1, 2), "snr": "NaN", "rssi": None}, "rx", "cc" * 32)
    assert result is not None
    assert result["timestamp"] == "2025-01-02T00:00:00Z"
    assert "path" not in result and "SNR" not in result and "RSSI" not in result
