import pytest

from app.services.channel_datagrams import decode_channel_datagram


def test_valid_binary_datagram_not_chat():
    item = decode_channel_datagram(
        {"payload": "00ff21", "channel_idx": 1, "data_type": 0x1234, "path_len": 255, "SNR": -3.25}
    )
    assert item is not None
    assert item["data"] == bytes.fromhex("00ff21")
    assert len(item["identity_hash"]) == 32
    assert item["data_type"] == 0x1234


def test_invalid_or_truncated_binary_datagram_is_rejected():
    template = {"payload": "aabb", "channel_idx": 1, "data_type": 42}
    for update in (
        {"payload": "aa0"},
        {"payload": "ab" * 164},
        {"channel_idx": -1},
        {"data_type": 0},
        {"data_type": "42"},
    ):
        assert decode_channel_datagram(template | update) is None


@pytest.mark.asyncio
async def test_binary_ingress_persists_and_deduplicates(test_db, monkeypatch):
    from app.services import channel_datagrams

    monkeypatch.setattr(channel_datagrams, "db", test_db)
    payload = {
        "payload": "deadbeef",
        "channel_idx": 2,
        "data_type": 0xFF01,
        "path_len": 255,
        "SNR": -5.5,
    }
    assert await channel_datagrams.stage_channel_datagram(payload) is True
    assert await channel_datagrams.stage_channel_datagram(payload) is False
    async with test_db.readonly() as conn:
        async with conn.execute("SELECT * FROM companion_channel_datagrams") as cursor:
            rows = await cursor.fetchall()
    assert len(rows) == 1
    assert rows[0]["channel_idx"] == 2
    assert rows[0]["data_type"] == 0xFF01
    assert rows[0]["payload"] == bytes.fromhex("deadbeef")
    assert rows[0]["attribution_status"] == "unresolved"
