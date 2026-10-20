"""Bounded Companion TCP framing.

The protocol is asymmetric: clients send ``<`` frames and the virtual
Companion sends ``>`` frames. The three-byte header is outside the firmware's
176-byte payload limit.
"""

import asyncio
import struct

MAX_FRAME_SIZE = 176
INBOUND_PREFIX = b"<"
OUTBOUND_PREFIX = b">"
HEADER_SIZE = 3


class FrameError(ValueError):
    """A peer supplied a frame that cannot be accepted safely."""


class FrameTimeout(FrameError):
    """A peer did not complete the next frame before the receive deadline."""


class TruncatedFrame(FrameError):
    """EOF arrived after part of a frame had already been received."""


def encode_frame(payload: bytes, *, prefix: bytes = OUTBOUND_PREFIX) -> bytes:
    """Encode one bounded frame for the wire."""
    if prefix not in (INBOUND_PREFIX, OUTBOUND_PREFIX):
        raise FrameError("invalid frame prefix")
    if not 1 <= len(payload) <= MAX_FRAME_SIZE:
        raise FrameError(f"payload length must be 1..{MAX_FRAME_SIZE} bytes")
    return prefix + struct.pack("<H", len(payload)) + payload


async def _readexactly(reader: asyncio.StreamReader, size: int, timeout: float) -> bytes:
    try:
        return await asyncio.wait_for(reader.readexactly(size), timeout=timeout)
    except TimeoutError as exc:
        raise FrameTimeout("timed out while reading Companion frame") from exc
    except asyncio.IncompleteReadError as exc:
        if not exc.partial and size == HEADER_SIZE:
            raise EOFError from exc
        raise TruncatedFrame("connection closed during Companion frame") from exc


async def read_frame(
    reader: asyncio.StreamReader,
    *,
    timeout: float,
    expected_prefix: bytes = INBOUND_PREFIX,
) -> bytes:
    """Read exactly one frame, preserving any coalesced bytes for the next call."""
    header = await _readexactly(reader, HEADER_SIZE, timeout)
    if header[:1] != expected_prefix:
        raise FrameError("unexpected Companion frame direction")
    (length,) = struct.unpack_from("<H", header, 1)
    if not 1 <= length <= MAX_FRAME_SIZE:
        raise FrameError(f"invalid Companion payload length {length}")
    return await _readexactly(reader, length, timeout)
