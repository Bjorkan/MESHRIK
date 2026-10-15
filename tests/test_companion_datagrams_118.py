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
