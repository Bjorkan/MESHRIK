"""Read-only radio job/activity snapshots and safe cancellation for #41.

No generic command execution endpoint exists. #42-44 will add individually
validated enqueue routes and may opt into 202 + RadioJobAccepted. Existing
synchronous send endpoints and the WebSocket protocol remain unchanged.
"""

from uuid import UUID

from fastapi import APIRouter, HTTPException, Query

from app.services.radio_job_worker import radio_job_scheduler, radio_job_worker
from app.services.radio_jobs import (
    RadioActivityPage,
    RadioCommandStatus,
    RadioConnectionStatus,
    RadioJobCancelResponse,
    RadioJobSnapshot,
    RadioJobsPage,
    RadioJobState,
    RadioStatusSnapshot,
)
from app.services.radio_runtime import radio_runtime

router = APIRouter(prefix="/radio", tags=["radio-jobs"])


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
