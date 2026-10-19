"""Generative checks for high-risk path, packet, and packet-identity invariants."""

from hypothesis import given, settings
from hypothesis import strategies as st

from app.path_utils import (
    MAX_PATH_SIZE,
    canonical_packet_digest,
    decode_path_byte,
    parse_packet_envelope,
    validate_path_byte,
)
from tests.property_strategies import packet_examples, path_shapes


@given(path_shapes())
@settings(max_examples=100)
def test_valid_path_encoding_round_trips(shape):
    hop_count, hash_size, _ = shape
    path_byte = hop_count | ((hash_size - 1) << 6)

    assert decode_path_byte(path_byte) == (hop_count, hash_size)
    assert validate_path_byte(path_byte) == (hop_count, hash_size, hop_count * hash_size)
    assert hop_count * hash_size <= MAX_PATH_SIZE


@given(packet_examples())
@settings(max_examples=100)
def test_packet_envelope_round_trips_canonical_fields(example):
    parsed = parse_packet_envelope(example.raw)

    assert parsed is not None
    assert parsed.route_type == example.route_type
    assert parsed.payload_type == example.payload_type
    assert parsed.payload_version == example.payload_version
    assert parsed.hop_count == example.hop_count
    assert parsed.hash_size == example.hash_size
    assert parsed.path == example.path
    assert parsed.payload == example.payload
    assert parsed.transport_codes == example.transport_codes


@given(st.binary(max_size=256))
@settings(max_examples=200)
def test_arbitrary_packet_bytes_fail_closed_or_return_a_bounded_envelope(raw):
    parsed = parse_packet_envelope(raw)

    if parsed is None:
        return
    assert parsed.path_byte_len == len(parsed.path) <= MAX_PATH_SIZE
    assert parsed.payload
    assert parsed.payload_offset + len(parsed.payload) == len(raw)


@given(
    packet_examples(payload_types=st.integers(min_value=0, max_value=15).filter(lambda n: n != 9))
)
@settings(max_examples=100)
def test_non_trace_packet_identity_ignores_observation_path(example):
    parsed = parse_packet_envelope(example.raw)
    assert parsed is not None
    alternate_path = bytes(byte ^ 0xFF for byte in example.path)
    alternate = bytearray(example.raw)
    path_start = parsed.payload_offset - parsed.path_byte_len
    alternate[path_start : parsed.payload_offset] = alternate_path

    assert canonical_packet_digest(example.raw) == canonical_packet_digest(bytes(alternate))
