"""Hardware-free source-derived Companion wire contract for stacked PR S01.

Synthetic fixture frames are NOT actual official Android/iOS connection captures.
The production virtual TCP server is introduced only in later stack layers.
"""

import json
import re
import struct
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
CONTRACT = json.loads(
    (ROOT / "tests/fixtures/virtual_companion_protocol_s01.json").read_text(encoding="utf-8")
)
BY_NAME = {sample["name"]: sample for sample in CONTRACT["examples"]}
DOC = (ROOT / "docs/VIRTUAL_COMPANION_PROTOCOL.md").read_text(encoding="utf-8")

# Independently pinned from firmware's MyMesh.cpp CMD_* declarations. IDs 44–49
# and 53 are not assigned in this source; new opcodes must be reviewed first.
EXPECTED_IDS = set(range(1, 44)) | {50, 51, 52} | set(range(54, 67))
FORBIDDEN_IDS = {
    6,
    7,
    8,
    11,
    12,
    14,
    16,
    17,
    19,
    21,
    23,
    24,
    25,
    26,
    27,
    29,
    32,
    33,
    34,
    35,
    36,
    37,
    38,
    39,
    41,
    50,
    51,
    52,
    54,
    55,
    57,
    58,
    61,
    62,
    63,
    65,
    66,
}


def payload(name: str) -> bytes:
    return bytes.fromhex(BY_NAME[name]["payload_hex"])


def test_fixture_provenance_and_required_source_coverage():
    assert "NOT captured" in CONTRACT["note"] or "NOT captures" in CONTRACT["note"]
    assert "NOT VERIFIED" in CONTRACT["capture_status"]
    assert "v1.18.0" in CONTRACT["source"]
    assert CONTRACT["frame_format"] == {
        "incoming_prefix": 60,
        "outgoing_prefix": 62,
        "length": "uint16 little endian",
        "max_payload": 176,
    }
    assert len(BY_NAME) == len(CONTRACT["examples"]) >= 20


@pytest.mark.parametrize("sample", CONTRACT["examples"], ids=lambda sample: sample["name"])
def test_source_golden_tcp_frame_matches_direction_length_and_payload(sample):
    p = bytes.fromhex(sample["payload_hex"])
    wire = bytes.fromhex(sample["tcp_hex"])
    assert 1 <= len(p) <= 176
    assert wire[:1] == (b"<" if sample["direction"] == "request" else b">")
    assert struct.unpack_from("<H", wire, 1)[0] == len(p)
    assert wire[3:] == p
    assert len(wire) == 3 + len(p)
    assert sample["source"].startswith("MyMesh.cpp:")


@pytest.mark.parametrize(
    ("name", "expected_wire"),
    [
        ("device_query_v14", "3c0200160e"),
        ("device_query_v13", "3c0200160d"),
        ("get_contacts_since", "3c05000404030201"),
        ("contacts_start", "3e05000202000000"),
        ("contacts_end", "3e05000404030201"),
        ("empty_queue", "3e01000a"),
        ("waiting_push", "3e010083"),
        ("unsupported", "3e02000101"),
        ("not_found", "3e02000102"),
        ("disabled", "3e01000f"),
    ],
)
def test_independently_pinned_short_golden_frames(name, expected_wire):
    assert BY_NAME[name]["tcp_hex"] == expected_wire


def test_source_contact_and_channel_binary_layouts():
    contact = payload("contact_entry")
    assert len(contact) == 148
    assert contact[0] == 3
    assert contact[1:33] == bytes([0x11]) * 32
    assert (contact[33], contact[34], contact[35]) == (1, 0, 0)
    assert contact[36:100] == bytes(64)
    assert contact[100:132].rstrip(b"\0") == b"Synthetic Contact"
    assert struct.unpack_from("<IIII", contact, 132) == (1700000000, 0, 0, 1700000100)

    channel = payload("channel_info")
    assert len(channel) == 50
    assert channel[:2] == bytes([18, 2])
    assert channel[2:34].rstrip(b"\0") == b"Synthetic"
    assert channel[34:] == bytes(range(16))


def test_self_info_and_device_info_use_exact_firmware_v14_offsets():
    info = payload("self_info")
    assert info[:4] == bytes([5, 1, 14, 22])
    assert info[4:36] == bytes([0x22]) * 32
    assert struct.unpack_from("<ii", info, 36) == (0, 0)
    assert info[44:48] == bytes(4)
    assert struct.unpack_from("<II", info, 48) == (915000, 250000)
    assert info[56:58] == bytes([11, 5])
    assert info[58:] == b"Synthetic Node"

    device = payload("device_info")
    assert len(device) == 82
    assert device[:4] == bytes([13, 14, 25, 10])
    assert device[4:8] == bytes(4)  # sample PIN is zero, not a real secret
    assert device[8:20].rstrip(b"\0") == b"15 Oct 2026"
    assert device[20:60].rstrip(b"\0") == b"Synthetic Board"
    assert device[60:80].rstrip(b"\0") == b"v1.18.0"
    assert device[80:] == bytes([0, 1])


def test_message_and_transmit_layouts_are_distinct_and_le():
    dm = payload("dm_receive_v3")
    assert dm[:4] == bytes([16, 0xFC, 0, 0])  # quarter-SNR -4 => -1 dB
    assert dm[4:10] == bytes([0x33]) * 6
    assert dm[10:12] == bytes([255, 0])
    assert struct.unpack_from("<I", dm, 12)[0] == 1700000200
    assert dm[16:] == b"Hello"

    channel = payload("channel_receive_v3")
    assert channel[:7] == bytes([17, 0xFC, 0, 0, 2, 0, 0])
    assert struct.unpack_from("<I", channel, 7)[0] == 1700000200
    assert channel[11:] == b"Channel hello"

    dm_tx = payload("dm_send")
    assert dm_tx[:3] == bytes([2, 0, 0])
    assert struct.unpack_from("<I", dm_tx, 3)[0] == 1700000200
    assert dm_tx[7:13] == bytes([0x33]) * 6
    assert dm_tx[13:] == b"Hello"

    chan_tx = payload("channel_send")
    assert chan_tx[:3] == bytes([3, 0, 2])
    assert struct.unpack_from("<I", chan_tx, 3)[0] == 1700000200
    assert chan_tx[7:] == b"Hi"

    sent = payload("dm_sent")
    ack = payload("ack_push")
    assert len(sent) == 10 and len(ack) == 9
    assert sent[:2] == bytes([6, 0])
    assert sent[2:6] == ack[1:5] == bytes([0x10, 0x20, 0x30, 0x40])
    assert struct.unpack_from("<I", sent, 6)[0] == 1000
    assert struct.unpack_from("<I", ack, 5)[0] == 1234


def test_command_policy_covers_every_firmware_opcode_and_denies_privileged_access():
    pattern = re.compile(
        r"^\| \`0x([0-9a-f]{2})\` \((\d+)\) \| \`CMD_([A-Z_]+)\` \| "
        r"\*\*([ABC])\*\* \|",
        re.MULTILINE,
    )
    entries = pattern.findall(DOC)
    ids = [int(number) for _hex, number, _name, _mode in entries]
    assert len(entries) == len(EXPECTED_IDS) == 59
    assert set(ids) == EXPECTED_IDS
    assert len(set(ids)) == len(ids)
    for code_hex, number, _name, _mode in entries:
        assert int(code_hex, 16) == int(number)
    policy = {int(num): mode for _hex, num, _name, mode in entries}
    assert all(policy[command] == "C" for command in FORBIDDEN_IDS)
    assert policy[1] == policy[4] == policy[10] == policy[22] == "A"
    assert policy[2] == policy[3] == "B"
    assert "default-deny" in DOC
