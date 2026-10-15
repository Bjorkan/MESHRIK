"""Public, payload-free radio job contract and validated state transitions.

Only enums, opaque identifiers, timestamps and bounded numeric display information
are serialized. Commands, recipient addresses, message text and credentials must
never be stored in the public job record (or in diagnostic events).
"""

from datetime import UTC, datetime
from enum import IntEnum, StrEnum
from typing import Literal
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


class RadioJobStage(StrEnum):
    """Predefined user-facing phase labels; never arbitrary transport text."""

    WAITING_TURN = "waiting_turn"
    TRANSPORT_COMMAND = "transport_command"
    WAITING_FOR_RESPONSE = "waiting_for_response"
    WAITING_FOR_ACK = "waiting_for_ack"
    RETRY_PENDING = "retry_pending"
    FINISHED = "finished"
    FAILED = "failed"
    CANCELLED = "cancelled"
    UNCERTAIN = "uncertain"


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
    TRACE = "trace"
    SERVER_QUERY = "server_query"
    CONTACT_QUERY = "contact_query"
    RADIO_QUERY = "radio_query"
    PERIODIC_SYNC = "periodic_sync"
    RADIO_STATS_SAMPLE = "radio_stats_sample"
    PERIODIC_ADVERTISEMENT = "periodic_advertisement"
    LIFECYCLE_DEVICE_INFO = "lifecycle_device_info"
    LIFECYCLE_KEY_EXPORT = "lifecycle_key_export"
    LIFECYCLE_CLOCK_SYNC = "lifecycle_clock_sync"
    LIFECYCLE_FLOOD_SCOPE = "lifecycle_flood_scope"
    LIFECYCLE_CONTACT_SYNC = "lifecycle_contact_sync"
    LIFECYCLE_CHANNEL_SYNC = "lifecycle_channel_sync"
    LIFECYCLE_CHANNEL_CLEAR = "lifecycle_channel_clear"
    LIFECYCLE_ADVERTISEMENT = "lifecycle_advertisement"
    LIFECYCLE_MESSAGE_DRAIN = "lifecycle_message_drain"
    LIFECYCLE_AUTO_FETCH = "lifecycle_auto_fetch"


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
    stage: RadioJobStage = RadioJobStage.WAITING_TURN
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


class RadioActivityKind(StrEnum):
    """Allowlisted, non-payload inbound/connection observations."""

    PACKET_RECEIVED = "packet_received"
    ACK_OBSERVED = "ack_observed"
    CONTACT_MESSAGE_OBSERVED = "contact_message_observed"
    PATH_UPDATE = "path_update"
    CONTACT_OBSERVED = "contact_observed"
    LOGIN_RESPONSE = "login_response"
    CLI_RESPONSE = "cli_response"
    CONNECTION_CHANGED = "connection_changed"


class RadioActivitySource(StrEnum):
    RAW_RF_LOG = "raw_rf_log"
    MESHCORE_EVENT = "meshcore_event"
    RADIO_LIFECYCLE = "radio_lifecycle"


RadioPacketType = Literal["channel", "direct", "advertisement", "ack", "path", "control", "other"]
RadioReadinessState = Literal[
    "ready",
    "connected",
    "degraded",
    "failed",
    "initializing",
    "connecting",
    "disconnected",
    "paused",
]


class RadioActivityRecord(BaseModel):
    """Only classification and opaque reliable job correlation; no RF payloads."""

    model_config = ConfigDict(frozen=True, extra="forbid")
    sequence: int = Field(ge=1)
    at: datetime
    kind: RadioActivityKind
    source: RadioActivitySource
    radio_generation: int = Field(ge=0)
    job_id: UUID | None = None
    # Public RF metadata is allowlisted: never include packet bodies, addresses,
    # decrypted messages, full public keys or private channel names.
    packet_type: (
        Literal["channel", "direct", "advertisement", "ack", "path", "control", "other"] | None
    ) = None
    rssi: int | None = Field(default=None, ge=-160, le=0)
    snr: float | None = Field(default=None, ge=-40, le=40)
    hops: int | None = Field(default=None, ge=0, le=64)
    previous_connected: bool | None = None
    connected: bool | None = None
    previous_readiness: RadioReadinessState | None = None
    readiness: RadioReadinessState | None = None


class RadioConnectionStatus(StrEnum):
    # Retained for older embedded runtimes that do not expose readiness.
    CONNECTED = "connected"
    READY = "ready"
    DEGRADED = "degraded"
    FAILED = "failed"
    INITIALIZING = "initializing"
    CONNECTING = "connecting"
    DISCONNECTED = "disconnected"


class RadioStartupStage(StrEnum):
    TRANSPORT = "transport"
    DEVICE_INFO = "device_info"
    KEY_EXPORT = "key_export"
    CLOCK_SYNC = "clock_sync"
    FLOOD_SCOPE = "flood_scope"
    CONTACT_SYNC = "contact_sync"
    CHANNEL_SYNC = "channel_sync"
    CHANNEL_CLEAR = "channel_clear"
    ADVERTISEMENT = "advertisement"
    MESSAGE_DRAIN = "message_drain"
    AUTO_FETCH = "auto_fetch"
    COMPLETE = "complete"
    RECOVERY_REQUIRED = "recovery_required"


class RadioCommandStatus(StrEnum):
    IDLE = "idle"
    EXECUTING = "executing"
    LEGACY_BUSY = "legacy_busy"  # existing lock occupied by non-scheduler code


class RadioStatusSnapshot(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")
    radio_status: RadioConnectionStatus
    command_status: RadioCommandStatus
    radio_generation: int = Field(ge=0)
    sequence: int = Field(ge=0)
    startup_policy: Literal["passive", "sync", "full"] = "sync"
    startup_stage: RadioStartupStage | None = None
    # Physical TX/listening state is NOT supported by the present driver.
    physical_rf_state: Literal["unavailable"] = "unavailable"


class RadioJobsPage(BaseModel):
    items: list[RadioJobSnapshot]
    next_cursor: int | None = None
    has_more: bool = False
    snapshot_sequence: int = Field(ge=0)
    radio: RadioStatusSnapshot


class RadioActivityPage(BaseModel):
    items: list[RadioActivityRecord]
    next_cursor: int | None = None
    has_more: bool = False
    gap: bool = False
    snapshot_sequence: int = Field(ge=0)
    radio: RadioStatusSnapshot


class RadioJobCancelResponse(BaseModel):
    job: RadioJobSnapshot
    # "cancel_requested" while executing never promises the transmission stopped.
    action: Literal["cancelled_before_dispatch", "stop_waiting", "requested", "unchanged"]


class RadioJobAccepted(BaseModel):
    """Future operation-specific 202 enqueue responses (#42-44)."""

    job_id: UUID
    state: RadioJobState
