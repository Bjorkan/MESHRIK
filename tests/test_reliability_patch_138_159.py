"""Hardware-independent safety regressions for the #138–#159 patch series."""

from unittest.mock import AsyncMock, patch

import pytest

from app.path_utils import calculate_packet_hash, canonical_packet_digest
from app.repository.messages import MessageRepository
from app.repository.raw_packets import RawPacketRepository
from app.services.rx_ingress import RxIngress


@pytest.mark.asyncio
async def test_raw_packet_identity_includes_type_and_trace_path_byte(test_db):
    # Direct route: header, hop metadata (0 hops), and identical bytes.
    a = bytes([(2 << 2) | 1, 0]) + b"same-body"
    b = bytes([(3 << 2) | 1, 0]) + b"same-body"
    assert canonical_packet_digest(a) != canonical_packet_digest(b)
    assert calculate_packet_hash(a) == canonical_packet_digest(a).hex()[:16].upper()
    a_id, created = await RawPacketRepository.create(a)
    b_id, created_b = await RawPacketRepository.create(b)
    assert created and created_b and a_id != b_id
    same_id, created_again = await RawPacketRepository.create(a)
    assert same_id == a_id and not created_again
    # TRACE hashes wire-encoded path metadata.
    trace_a = bytes([(9 << 2) | 1, 1, 0xAA]) + b"same-body"
    trace_b = bytes([(9 << 2) | 1, 2, 0xAA, 0xBB]) + b"same-body"
    assert canonical_packet_digest(trace_a) != canonical_packet_digest(trace_b)


@pytest.mark.asyncio
async def test_two_same_second_chat_messages_with_distinct_wire_ids_persist(test_db):
    base = {
        "msg_type": "CHAN",
        "text": "same text",
        "conversation_key": "B1" * 16,
        "sender_timestamp": 1700000000,
        "received_at": 1700000000,
    }
    first = await MessageRepository.create(**base, wire_packet_id=11)
    second = await MessageRepository.create(**base, wire_packet_id=12)
    assert first is not None and second is not None and first != second
    assert await MessageRepository.create(**base, wire_packet_id=11) is None


@pytest.mark.asyncio
async def test_duplicate_paths_do_not_inflate_history(test_db):
    msg_id = await MessageRepository.create(
        msg_type="CHAN",
        text="echo",
        conversation_key="B2" * 16,
        sender_timestamp=1700000000,
        received_at=1700000000,
        outgoing=True,
    )
    for i in range(100):
        paths, is_new = await MessageRepository.add_path_with_status(
            msg_id,
            "aabb",
            1700000000,
            2,
        )
        assert len(paths) == 1
        assert is_new == (i == 0)
    for i in range(30):
        paths, is_new = await MessageRepository.add_path_with_status(
            msg_id,
            f"{i:04x}",
            1700000000,
            2,
        )
        assert is_new
        assert len(paths) <= 16


@pytest.mark.asyncio
async def test_rx_admission_is_bounded_and_invalid_events_isolated():
    ingress = RxIngress(capacity=2)
    with patch("app.packet_processor.process_raw_packet", new_callable=AsyncMock) as processing:
        assert not ingress.submit({"payload": "not hex"})
        assert ingress.invalid == 1
        assert ingress.submit({"payload": "0102"})
        assert ingress.submit({"payload": "0304"})
        assert not ingress.submit({"payload": "0506"})
        assert ingress.dropped == 1
        await ingress.queue.join()
        assert processing.await_count == 2
        await ingress.stop()
