"""Bounded serial RX processor: SDK callbacks never spawn DB tasks per frame.

Frames admitted to the queue are processed in receive order. Overflow is a
counted loss of host-side raw observations, NOT a claim of firmware RF loss.
"""

import asyncio
import logging
from dataclasses import dataclass
from time import monotonic

logger = logging.getLogger(__name__)
MAX_RX_BACKLOG = 2048


@dataclass(frozen=True)
class RxObservation:
    raw: bytes
    snr: float | None
    rssi: int | None
    enqueued_at: float


class RxIngress:
    def __init__(self, capacity: int = MAX_RX_BACKLOG):
        self.queue: asyncio.Queue[RxObservation] = asyncio.Queue(maxsize=capacity)
        self.worker: asyncio.Task | None = None
        self.accepted = 0
        self.dropped = 0
        self.invalid = 0
        self.failed = 0
        self.committed = 0
        self.last_commit_latency_ms = 0.0

    def submit(self, payload: dict) -> bool:
        try:
            raw = bytes.fromhex(payload["payload"])
            if not raw or len(raw) > 1024:
                raise ValueError("Invalid frame length")
        except (ValueError, TypeError, KeyError):
            self.invalid += 1
            return False
        if self.queue.full():
            self.dropped += 1
            if self.dropped == 1 or self.dropped % 100 == 0:
                logger.warning("RX host backlog overflow, dropped observations=%d", self.dropped)
            return False
        self.queue.put_nowait(
            RxObservation(raw, payload.get("snr"), payload.get("rssi"), monotonic())
        )
        self.accepted += 1
        if self.worker is None or self.worker.done():
            self.worker = asyncio.create_task(self._consume(), name="bounded-rx-ingress")
        return True

    async def _consume(self) -> None:
        from app.packet_processor import process_raw_packet

        try:
            while True:
                observation = await self.queue.get()
                try:
                    await process_raw_packet(
                        raw_bytes=observation.raw,
                        snr=observation.snr,
                        rssi=observation.rssi,
                    )
                    self.committed += 1
                    self.last_commit_latency_ms = (monotonic() - observation.enqueued_at) * 1000
                except Exception as exc:
                    self.failed += 1
                    logger.warning("RX packet processing failed (%s)", type(exc).__name__)
                finally:
                    self.queue.task_done()
        except asyncio.CancelledError:
            raise

    async def stop(self) -> None:
        if self.worker is not None and not self.worker.done():
            await self.queue.join()
            self.worker.cancel()
            try:
                await self.worker
            except asyncio.CancelledError:
                pass
        self.worker = None

    def snapshot(self) -> dict[str, int | float]:
        return {
            "accepted": self.accepted,
            "dropped": self.dropped,
            "invalid": self.invalid,
            "failed": self.failed,
            "committed": self.committed,
            "depth": self.queue.qsize(),
            "last_commit_latency_ms": self.last_commit_latency_ms,
        }


rx_ingress = RxIngress()
