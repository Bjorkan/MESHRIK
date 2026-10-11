"""Sanitized radio job/activity API and allowlisted asynchronous operations.

No generic command executor is exposed. Existing message and radio endpoints
keep their synchronous responses; opt-in typed enqueue routes return 202.
"""

from hashlib import sha256
from time import time
from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Header, HTTPException, Query
from pydantic import BaseModel, ConfigDict

from app.event_handlers import track_pending_ack
from app.models import SendChannelMessageRequest, SendDirectMessageRequest
from app.radio_sync import send_advertisement
from app.repository import (
    AmbiguousPublicKeyPrefixError,
    ChannelRepository,
    ContactRepository,
    MessageRepository,
)
from app.services.message_send import (
    SCOPE_UNSET,
    send_channel_message_to_channel,
    send_direct_message_to_contact,
)
from app.services.radio_job_scheduler import (
    RadioAdmissionError,
    RadioIdempotencyConflict,
)
from app.services.radio_job_worker import (
    RadioCommandOutcome,
    radio_job_scheduler,
    radio_job_worker,
)
from app.services.radio_jobs import (
    RadioActivityPage,
    RadioCommandStatus,
    RadioConnectionStatus,
    RadioJobAccepted,
    RadioJobCancelResponse,
    RadioJobKind,
    RadioJobPriority,
    RadioJobSnapshot,
    RadioJobsPage,
    RadioJobState,
    RadioStatusSnapshot,
)
from app.services.radio_runtime import radio_runtime
from app.websocket import broadcast_error, broadcast_event

router = APIRouter(prefix="/radio", tags=["radio-jobs"])


class EnqueueAdvertisement(BaseModel):
    """One explicit, validated manual advertisement; never raw MeshCore commands."""

    model_config = ConfigDict(extra="forbid")

    mode: Literal["flood", "zero_hop"] = "flood"


def _admit_command(kind, command, request, idempotency_key: str) -> RadioJobAccepted:
    """One durable-request fingerprint per accepted *in-memory* radio operation.

    The full request (including private message text and destination) is only
    hashed for idempotency, never copied into a public job/event snapshot.
    """
    fingerprint = sha256(request.model_dump_json().encode()).hexdigest()
    try:
        job = radio_job_worker.submit(
            kind,
            command,
            priority=RadioJobPriority.HIGH,
            scope=f"async-{kind.value}",
            idempotency_key=idempotency_key,
            request_fingerprint=fingerprint,
            queue_timeout_seconds=60,
            command_timeout_seconds=120,
            response_timeout_seconds=180,
        )
    except RadioIdempotencyConflict as exc:
        raise HTTPException(status_code=409, detail="Idempotency key already used") from exc
    except RadioAdmissionError as exc:
        raise HTTPException(
            status_code=503,
            detail="Radio command queue unavailable; retry later",
            headers={"Retry-After": "5"},
        ) from exc
    return RadioJobAccepted(job_id=job.id, state=job.state)


@router.post("/jobs/send/direct", status_code=202, response_model=RadioJobAccepted)
async def enqueue_direct_message(
    request: SendDirectMessageRequest,
    idempotency_key: str = Header(min_length=8, max_length=128, alias="Idempotency-Key"),
) -> RadioJobAccepted:
    """Opt-in asynchronous DM without changing POST /messages/direct."""
    radio_runtime.require_connected()
    try:
        contact = await ContactRepository.get_by_key_or_prefix(request.destination)
    except AmbiguousPublicKeyPrefixError as exc:
        raise HTTPException(
            status_code=409, detail="Ambiguous destination; use a full key"
        ) from exc
    if contact is None:
        raise HTTPException(status_code=404, detail="Contact not found")
    if len(contact.public_key) < 64:
        raise HTTPException(status_code=409, detail="Contact key is unresolved")

    async def command(_mc):
        # The service's radio_operation is reentrant ONLY on the owning worker
        # task and reuses its lower-level radio lock. SQLite/ACK behavior is
        # identical to the original synchronous endpoint.
        await send_direct_message_to_contact(
            contact=contact,
            text=request.text,
            radio_manager=radio_runtime,
            broadcast_fn=broadcast_event,
            track_pending_ack_fn=track_pending_ack,
            now_fn=time,
            message_repository=MessageRepository,
            contact_repository=ContactRepository,
        )
        return RadioCommandOutcome.UNCERTAIN  # await ACK via the durable DM tracker

    return _admit_command(RadioJobKind.DIRECT_MESSAGE, command, request, idempotency_key)


@router.post("/jobs/send/channel", status_code=202, response_model=RadioJobAccepted)
async def enqueue_channel_message(
    request: SendChannelMessageRequest,
    idempotency_key: str = Header(min_length=8, max_length=128, alias="Idempotency-Key"),
) -> RadioJobAccepted:
    """Opt-in async channel send; a 202 is NOT an echo or delivery receipt."""
    radio_runtime.require_connected()
    channel = await ChannelRepository.get_by_key(request.channel_key)
    if channel is None:
        raise HTTPException(status_code=404, detail="Channel not found")
    try:
        key_bytes = bytes.fromhex(request.channel_key)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="Invalid channel key") from exc

    async def command(_mc):
        await send_channel_message_to_channel(
            channel=channel,
            channel_key_upper=request.channel_key.upper(),
            key_bytes=key_bytes,
            text=request.text,
            radio_manager=radio_runtime,
            broadcast_fn=broadcast_event,
            error_broadcast_fn=broadcast_error,
            now_fn=time,
            temp_radio_slot=0,
            flood_scope_override=(
                SCOPE_UNSET
                if request.flood_scope_override is None
                else request.flood_scope_override
            ),
            message_repository=MessageRepository,
        )
        # No correlated RF echo is guaranteed. Durable Message.send_status is
        # updated by the existing sender/echo path independently of job state.
        return RadioCommandOutcome.UNCERTAIN

    return _admit_command(RadioJobKind.CHANNEL_MESSAGE, command, request, idempotency_key)


@router.post("/jobs/advertise", status_code=202, response_model=RadioJobAccepted)
async def enqueue_advertisement(
    request: EnqueueAdvertisement,
    idempotency_key: str = Header(min_length=8, max_length=128, alias="Idempotency-Key"),
) -> RadioJobAccepted:
    """Opt-in enqueue, while the original /radio/advertise API stays synchronous.

    The response confirms admission only, not RF transmission or a remote echo.
    Reusing the same idempotency key + request returns the original job, including
    after it has finished. A different payload with the same key returns 409.
    """
    radio_runtime.require_connected()
    fingerprint = sha256(f"manual_advertisement:{request.mode}".encode()).hexdigest()

    async def command(mc):
        # This is the ONLY transport command callback for this accepted job.
        # The existing send helper records the shared flood-advert throttle.
        success = await send_advertisement(mc, force=True, mode=request.mode)
        return RadioCommandOutcome.UNCERTAIN if not success else RadioCommandOutcome.FINISHED

    try:
        job = radio_job_worker.submit(
            RadioJobKind.ADVERTISEMENT,
            command,
            priority=RadioJobPriority.NORMAL,
            scope="manual-advertisement",
            idempotency_key=idempotency_key,
            request_fingerprint=fingerprint,
            queue_timeout_seconds=60,
            command_timeout_seconds=20,
        )
    except RadioIdempotencyConflict as exc:
        raise HTTPException(status_code=409, detail="Idempotency key already used") from exc
    except RadioAdmissionError as exc:
        raise HTTPException(
            status_code=503,
            detail="Radio command queue unavailable; retry later",
            headers={"Retry-After": "5"},
        ) from exc
    return RadioJobAccepted(job_id=job.id, state=job.state)


def radio_status_snapshot() -> RadioStatusSnapshot:
    """Scheduled command slot is not physical RF TX or continuous listening."""
    connected = bool(radio_runtime.is_connected)
    if connected and not bool(getattr(radio_runtime, "is_setup_in_progress", False)):
        radio_status = RadioConnectionStatus.CONNECTED
    elif connected or bool(getattr(radio_runtime, "is_reconnecting", False)):
        radio_status = RadioConnectionStatus.CONNECTING
    else:
        radio_status = RadioConnectionStatus.DISCONNECTED

    if any(j.state == RadioJobState.EXECUTING for j in radio_job_scheduler.list_jobs()):
        command_status = RadioCommandStatus.EXECUTING
    else:
        operation_lock = getattr(radio_runtime.manager, "_operation_lock", None)
        command_status = (
            RadioCommandStatus.LEGACY_BUSY
            if operation_lock is not None and operation_lock.locked()
            else RadioCommandStatus.IDLE
        )
    return RadioStatusSnapshot(
        radio_status=radio_status,
        command_status=command_status,
        radio_generation=radio_job_scheduler.generation,
        sequence=radio_job_scheduler.sequence,
    )


@router.get("/jobs", response_model=RadioJobsPage)
async def list_radio_jobs(
    status: RadioJobState | None = None,
    limit: int = Query(50, ge=1, le=100),
    cursor: int | None = Query(None, ge=0),
) -> RadioJobsPage:
    """Newest-updated-first; cursor is exclusive update sequence, not a row ID."""
    jobs = sorted(
        (
            job
            for job in radio_job_scheduler.list_jobs()
            if (status is None or job.state == status) and (cursor is None or job.sequence < cursor)
        ),
        key=lambda job: job.sequence,
        reverse=True,
    )
    page = jobs[:limit]
    has_more = len(jobs) > limit
    return RadioJobsPage(
        items=page,
        next_cursor=page[-1].sequence if has_more and page else None,
        has_more=has_more,
        snapshot_sequence=radio_job_scheduler.sequence,
        radio=radio_status_snapshot(),
    )


@router.get("/jobs/{job_id}", response_model=RadioJobSnapshot)
async def get_radio_job(job_id: UUID) -> RadioJobSnapshot:
    job = radio_job_scheduler.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Radio job not found")
    return job


@router.post("/jobs/{job_id}/cancel", response_model=RadioJobCancelResponse)
async def cancel_radio_job(job_id: UUID) -> RadioJobCancelResponse:
    before = radio_job_scheduler.get(job_id)
    if before is None:
        raise HTTPException(status_code=404, detail="Radio job not found")
    after = radio_job_worker.cancel(job_id)
    if after.version == before.version:
        action = "unchanged"
    elif before.state in (RadioJobState.QUEUED, RadioJobState.RETRYING):
        action = "cancelled_before_dispatch"
    elif before.state in (RadioJobState.AWAITING_ACK, RadioJobState.AWAITING_RESPONSE):
        action = "stop_waiting"
    else:
        action = "requested"
    return RadioJobCancelResponse(job=after, action=action)


@router.get("/activity", response_model=RadioActivityPage)
async def list_radio_activity(
    cursor: int | None = Query(None, ge=0),
    limit: int = Query(50, ge=1, le=100),
) -> RadioActivityPage:
    """Ascending event-sequence replay. No RF payload, text or private addresses."""
    # A missing cursor reads the most recent N items; a supplied cursor replays
    # from that sequence, with an explicit gap flag if the ring overflowed.
    activities, gap = radio_job_scheduler.activities_since(cursor or 0)
    if cursor is None:
        activities = activities[-limit:]
    page = activities[:limit]
    has_more = len(activities) > len(page)
    return RadioActivityPage(
        items=page,
        next_cursor=page[-1].sequence if page else cursor,
        has_more=has_more,
        gap=gap,
        snapshot_sequence=radio_job_scheduler.sequence,
        radio=radio_status_snapshot(),
    )
