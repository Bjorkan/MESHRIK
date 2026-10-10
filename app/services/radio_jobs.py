"""Public, payload-free radio job contract and validated state transitions.

Only enums, opaque identifiers, timestamps and bounded numeric display information
are serialized. Commands, recipient addresses, message text and credentials must
never be stored in the public job record (or in diagnostic events).
"""

from datetime import UTC, datetime
from enum import IntEnum, StrEnum
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field


class RadioJobState(StrEnum):
    QUEUED = "queued"
    EXECUTING = "executing"
    AWAITING_RESPONSE = "awaiting_response"
    AWAITING_ACK = "awaiting_ack"
    RETRYING = "retrying"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"
    UNKNOWN = "unknown"


class RadioJobPriority(IntEnum):
    HIGH = 0
    NORMAL = 10
    LOW = 20


class RadioJobKind(StrEnum):
    """Safe, fixed identifiers; never use arbitrary command or target strings."""

    DIRECT_MESSAGE = "direct_message"
    CHANNEL_MESSAGE = "channel_message"
    REPEATER_LOGIN = "repeater_login"
    ROOM_LOGIN = "room_login"
    RADIO_SETTINGS = "radio_settings"
    ADVERTISEMENT = "advertisement"
    DISCOVERY = "discovery"
    RADIO_QUERY = "radio_query"
    PERIODIC_SYNC = "periodic_sync"
    PERIODIC_ADVERTISEMENT = "periodic_advertisement"


class RadioJobResult(StrEnum):
    """Outcome codes only, not arbitrary exception messages or radio payloads."""

    COMMAND_FINISHED = "command_finished"  # local command, NOT RF delivery
    RESPONSE_RECEIVED = "response_received"
    ACK_RECEIVED = "ack_received"
    REJECTED = "rejected"
    QUEUE_EXPIRED = "queue_expired"
    RESPONSE_EXPIRED = "response_expired"
    COMMAND_ERROR = "command_error"
    COMMAND_TIMEOUT = "command_timeout"
    RADIO_CHANGED = "radio_changed"
    SHUTDOWN = "shutdown"
    CANCELLED_BEFORE_SEND = "cancelled_before_send"
    STOPPED_WAITING = "stopped_waiting"
    TRANSMISSION_UNCERTAIN = "transmission_uncertain"


TERMINAL_STATES = frozenset(
    {RadioJobState.COMPLETED, RadioJobState.FAILED, RadioJobState.CANCELLED, RadioJobState.UNKNOWN}
)

# A response waiter never occupies the command permit. RETRYING goes back to
# QUEUED for admission, rather than silently holding the command slot.
ALLOWED_TRANSITIONS: dict[RadioJobState, frozenset[RadioJobState]] = {
    RadioJobState.QUEUED: frozenset(
        {RadioJobState.EXECUTING, RadioJobState.CANCELLED, RadioJobState.FAILED}
    ),
    RadioJobState.EXECUTING: frozenset(
        {
            RadioJobState.AWAITING_RESPONSE,
            RadioJobState.AWAITING_ACK,
            RadioJobState.RETRYING,
            RadioJobState.COMPLETED,
            RadioJobState.FAILED,
            RadioJobState.CANCELLED,
            RadioJobState.UNKNOWN,
        }
    ),
    RadioJobState.AWAITING_RESPONSE: frozenset(
        {
            RadioJobState.RETRYING,
            RadioJobState.COMPLETED,
            RadioJobState.FAILED,
            RadioJobState.CANCELLED,
            RadioJobState.UNKNOWN,
        }
    ),
    RadioJobState.AWAITING_ACK: frozenset(
        {
            RadioJobState.RETRYING,
            RadioJobState.COMPLETED,
            RadioJobState.FAILED,
            RadioJobState.CANCELLED,
            RadioJobState.UNKNOWN,
        }
    ),
    RadioJobState.RETRYING: frozenset(
        {RadioJobState.QUEUED, RadioJobState.CANCELLED, RadioJobState.UNKNOWN}
    ),
    **{state: frozenset() for state in TERMINAL_STATES},
}


class InvalidJobTransition(ValueError):
    """An illegal or terminal-state transition was requested."""


class RadioJobSnapshot(BaseModel):
    """Frozen JSON-safe view. No command inputs or untrusted free-text fields."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    id: UUID
    kind: RadioJobKind
    state: RadioJobState
    priority: RadioJobPriority
    version: int = Field(ge=1)
    sequence: int = Field(ge=1)
    radio_generation: int = Field(ge=0)
    created_at: datetime
    updated_at: datetime
    queue_entered_at: datetime
    started_at: datetime | None = None
    completed_at: datetime | None = None
    command_deadline: datetime | None = None
    response_deadline: datetime | None = None
    queue_deadline: datetime | None = None
    # An opaque generated scope token, never the caller-supplied correlation key.
    correlation_scope: UUID
    cancellation_requested: bool = False
    result: RadioJobResult | None = None
    attempt: int = Field(default=1, ge=1, le=100)


class RadioJobEvent(BaseModel):
    """Bounded event/replay record for subsequent REST/WS integration (#41)."""

    model_config = ConfigDict(frozen=True, extra="forbid")
    job_id: UUID
    state: RadioJobState
    version: int
    sequence: int
    at: datetime


def utc_now() -> datetime:
    return datetime.now(UTC)


def require_utc(value: datetime) -> datetime:
    if value.tzinfo is None or value.utcoffset() is None:
        raise ValueError("Radio job timestamps must be timezone-aware")
    return value.astimezone(UTC)
