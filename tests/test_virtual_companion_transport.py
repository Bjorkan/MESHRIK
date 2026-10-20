"""S02 tests for the inert virtual Companion TCP transport."""

import asyncio
import inspect
import struct

import pytest

from app.services.virtual_companion.dispatch import CommandDispatcher
from app.services.virtual_companion.framing import (
    FrameError,
    FrameTimeout,
    TruncatedFrame,
    encode_frame,
    read_frame,
)
from app.services.virtual_companion.server import VirtualCompanionServer
from app.services.virtual_companion.session import (
    ClientBackpressure,
    VirtualCompanionSession,
)


def make_reader(data: bytes) -> asyncio.StreamReader:
    reader = asyncio.StreamReader()
    reader.feed_data(data)
    reader.feed_eof()
    return reader


@pytest.mark.asyncio
async def test_fragmented_and_coalesced_frames_use_little_endian_lengths():
    reader = asyncio.StreamReader()
    task = asyncio.create_task(read_frame(reader, timeout=0.2))
    for chunk in (b"<", b"\x02", b"\x00\x16", b"\x0e<\x01\x00\x04"):
        reader.feed_data(chunk)
        await asyncio.sleep(0)
    assert await task == b"\x16\x0e"
    assert await read_frame(reader, timeout=0.2) == b"\x04"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "wire,exception",
    [
        (b">\x01\x00x", FrameError),
        (b"<\x00\x00", FrameError),
        (b"<\xb1\x00", FrameError),
        (b"<\x02\x00x", TruncatedFrame),
    ],
)
async def test_invalid_frame_boundaries_fail_closed(wire, exception):
    with pytest.raises(exception):
        await read_frame(make_reader(wire), timeout=0.1)


@pytest.mark.asyncio
async def test_clean_eof_and_idle_timeout_are_distinct():
    with pytest.raises(EOFError):
        await read_frame(make_reader(b""), timeout=0.1)
    with pytest.raises(FrameTimeout):
        await read_frame(asyncio.StreamReader(), timeout=0.01)


def test_encoder_bounds_and_direction():
    payload = bytes(range(176))
    wire = encode_frame(payload)
    assert wire[:3] == b">\xb0\x00"
    assert wire[3:] == payload
    for invalid in (b"", b"x" * 177):
        with pytest.raises(FrameError):
            encode_frame(invalid)


@pytest.mark.asyncio
async def test_dispatcher_is_default_deny_and_validates_lengths():
    dispatcher = CommandDispatcher()
    assert await dispatcher.dispatch(b"\x17") == b"\x01\x01"  # private-key export
    assert await dispatcher.dispatch(b"\x41") == b"\x01\x01"  # raw packet send
    assert await dispatcher.dispatch(b"\x42") == b"\x01\x01"  # CLI

    seen = []

    async def handle(payload):
        seen.append(payload)
        return b"\x0d"

    dispatcher.register(0x16, handle, min_length=2, max_length=2)
    assert await dispatcher.dispatch(b"\x16") == b"\x01\x06"
    assert await dispatcher.dispatch(b"\x16\x0e\x00") == b"\x01\x06"
    assert await dispatcher.dispatch(b"\x16\x0e") == b"\x0d"
    assert seen == [b"\x16\x0e"]
    with pytest.raises(ValueError):
        dispatcher.register(0x16, handle, min_length=2, max_length=2)


class RecordingWriter:
    def __init__(self, *, block_drain=False):
        self.data = bytearray()
        self.closed = False
        self._drain_gate = asyncio.Event()
        if not block_drain:
            self._drain_gate.set()

    def write(self, data):
        self.data.extend(data)

    async def drain(self):
        await self._drain_gate.wait()

    def close(self):
        self.closed = True
        self._drain_gate.set()

    async def wait_closed(self):
        return None


@pytest.mark.asyncio
async def test_each_session_has_independent_state_and_bounded_queue():
    dispatcher = CommandDispatcher()
    first = VirtualCompanionSession(
        asyncio.StreamReader(), RecordingWriter(), dispatcher, outbox_size=1
    )
    second = VirtualCompanionSession(
        asyncio.StreamReader(), RecordingWriter(), dispatcher, outbox_size=1
    )
    first.state.protocol_version = 14
    first.state.message_cursor = 7
    assert second.state.protocol_version is None
    assert second.state.message_cursor == 0
    first.enqueue_push(b"\x83")
    with pytest.raises(ClientBackpressure):
        first.enqueue_push(b"\x83")
    second.enqueue_push(b"\x83")


@pytest.mark.asyncio
async def test_response_priority_and_fifo_order():
    session = VirtualCompanionSession(
        asyncio.StreamReader(), RecordingWriter(), CommandDispatcher(), outbox_size=4
    )
    session.enqueue_push(b"push-1")
    session.enqueue_push(b"push-2")
    session._enqueue_response(b"reply-1")
    session._enqueue_response(b"reply-2")
    assert [await session._next_outbound() for _ in range(4)] == [
        b"reply-1",
        b"reply-2",
        b"push-1",
        b"push-2",
    ]


@pytest.mark.asyncio
async def test_stalled_writer_is_evicted_after_bounded_timeout():
    reader = asyncio.StreamReader()
    writer = RecordingWriter(block_drain=True)
    session = VirtualCompanionSession(
        reader,
        writer,
        CommandDispatcher(),
        outbox_size=2,
        read_timeout=1,
        write_timeout=0.01,
    )
    reader.feed_data(b"<\x01\x00\xff")
    await asyncio.wait_for(session.run(), timeout=0.2)
    assert session.closed
    assert writer.closed


async def read_wire_frame(reader):
    header = await asyncio.wait_for(reader.readexactly(3), timeout=1)
    assert header[:1] == b">"
    return await reader.readexactly(struct.unpack_from("<H", header, 1)[0])


@pytest.mark.asyncio
async def test_loopback_server_keeps_two_clients_isolated_and_ordered():
    dispatcher = CommandDispatcher()

    async def echo(payload):
        return bytes((0x20, payload[1]))

    dispatcher.register(0x16, echo, min_length=2, max_length=2)
    server = VirtualCompanionServer(dispatcher)
    await server.start("127.0.0.1", 0)
    port = server.sockets[0].getsockname()[1]
    reader_a, writer_a = await asyncio.open_connection("127.0.0.1", port)
    reader_b, writer_b = await asyncio.open_connection("127.0.0.1", port)
    try:
        writer_a.write(b"<\x02\x00\x16\x0d<\x02\x00\x16\x0e")
        writer_b.write(b"<\x02\x00\x16\x09")
        await asyncio.gather(writer_a.drain(), writer_b.drain())
        assert await read_wire_frame(reader_a) == b"\x20\x0d"
        assert await read_wire_frame(reader_a) == b"\x20\x0e"
        assert await read_wire_frame(reader_b) == b"\x20\x09"
        writer_a.close()
        await writer_a.wait_closed()
        await asyncio.sleep(0.01)
        assert server.client_count == 1
        writer_b.write(b"<\x02\x00\x16\x0a")
        await writer_b.drain()
        assert await read_wire_frame(reader_b) == b"\x20\x0a"
    finally:
        writer_b.close()
        await writer_b.wait_closed()
        await server.stop()
    assert server.client_count == 0
    assert not server.listening


@pytest.mark.asyncio
async def test_server_shutdown_does_not_cancel_dispatched_domain_operation():
    started = asyncio.Event()
    release = asyncio.Event()
    completed = asyncio.Event()
    dispatcher = CommandDispatcher()

    async def operation(_payload):
        started.set()
        await release.wait()
        completed.set()
        return b"\x00"

    dispatcher.register(0x16, operation, min_length=2, max_length=2)
    server = VirtualCompanionServer(dispatcher)
    await server.start("127.0.0.1", 0)
    port = server.sockets[0].getsockname()[1]
    _reader, writer = await asyncio.open_connection("127.0.0.1", port)
    writer.write(b"<\x02\x00\x16\x0e")
    await writer.drain()
    await asyncio.wait_for(started.wait(), timeout=1)
    await asyncio.wait_for(server.stop(), timeout=1)
    assert not completed.is_set()
    release.set()
    await asyncio.wait_for(completed.wait(), timeout=1)
    writer.close()
    await writer.wait_closed()


def test_transport_has_no_radio_or_meshcore_dependency():
    import app.services.virtual_companion.dispatch as dispatch_module
    import app.services.virtual_companion.framing as framing_module
    import app.services.virtual_companion.server as server_module
    import app.services.virtual_companion.session as session_module

    source = "\n".join(
        inspect.getsource(module)
        for module in (dispatch_module, framing_module, server_module, session_module)
    )
    assert "app.radio" not in source
    assert "radio_runtime" not in source
    assert "meshcore" not in source.lower()
    assert "create_tcp" not in source
