import logging
import time
from typing import TYPE_CHECKING

from meshcore import EventType

from app.models import CONTACT_TYPE_ROOM, Contact, ContactUpsert
from app.repository import (
    ContactRepository,
)
from app.services import dm_ack_tracker
from app.services.contact_reconciliation import (
    promote_prefix_contacts_for_contact,
    record_contact_name_and_reconcile,
)
from app.services.dm_ack_apply import apply_dm_ack_code
from app.services.dm_ingest import (
    ingest_fallback_direct_message,
    resolve_direct_message_sender_metadata,
    resolve_fallback_direct_message_context,
)
from app.websocket import broadcast_event

if TYPE_CHECKING:
    from meshcore.events import Event, Subscription

logger = logging.getLogger(__name__)

# A single warning per radio generation per five minutes; no write attempts.
_last_contacts_full_warning: tuple[int, float] | None = None


async def on_radio_contact_deleted(
    event: "Event",
    *,
    generation: int | None = None,
    source: object | None = None,
    received_at: float | None = None,
) -> None:
    """0x8F automatic *firmware overwrite*, not an application delete.

    Older dispatcher callbacks and stale pending notifications cannot undo a
    newer radio snapshot/re-add. Only a full 32-byte key is accepted.
    """
    import re

    from app.services.contact_residency import was_confirmed_after
    from app.services.radio_runtime import radio_runtime

    generation = radio_runtime.radio_generation if generation is None else generation
    received_at = time.monotonic() if received_at is None else received_at
    if generation is None:
        return
    if generation != radio_runtime.radio_generation or (
        source is not None and radio_runtime.meshcore is not source
    ):
        return
    key = event.payload.get("pubkey") if isinstance(event.payload, dict) else None
    if not isinstance(key, str) or re.fullmatch(r"[0-9a-fA-F]{64}", key) is None:
        logger.debug("Ignored malformed Companion contact-overwrite notification")
        return
    key = key.lower()
    if was_confirmed_after(key, generation, received_at):
        return
    contact = await ContactRepository.get_by_key(key)
    if contact is None or not contact.on_radio:
        return
    if generation != radio_runtime.radio_generation or was_confirmed_after(
        key, generation, received_at
    ):
        return
    if not await ContactRepository.set_radio_contact_not_resident(key):
        return
    updated = await ContactRepository.get_by_key(key)
    if updated is not None:
        broadcast_event("contact", updated.model_dump())


async def on_radio_contacts_full(
    event: "Event",
    *,
    generation: int | None = None,
    source: object | None = None,
) -> None:
    """0x90 is a bounded operator warning, never a delete/re-add instruction."""
    from app.services.radio_runtime import radio_runtime
    from app.websocket import broadcast_error

    generation = radio_runtime.radio_generation if generation is None else generation
    if generation is None:
        return
    if generation != radio_runtime.radio_generation or (
        source is not None and source is not radio_runtime.meshcore
    ):
        return
    global _last_contacts_full_warning
    now = time.monotonic()
    if _last_contacts_full_warning is not None and (
        _last_contacts_full_warning[0] == generation and now - _last_contacts_full_warning[1] < 300
    ):
        return
    _last_contacts_full_warning = generation, now
    broadcast_error(
        "Companion contact storage full",
        "The radio contact table is full. Review radio-resident contacts manually; "
        "MESHRIK will not automatically delete or replace contacts.",
    )


# Track active subscriptions so we can unsubscribe before re-registering
# This prevents handler duplication after reconnects
_active_subscriptions: list["Subscription"] = []


def track_pending_ack(expected_ack: str, message_id: int, timeout_ms: int) -> bool:
    """Compatibility wrapper for pending DM ACK tracking."""
    return dm_ack_tracker.track_pending_ack(expected_ack, message_id, timeout_ms)


def cleanup_expired_acks() -> None:
    """Compatibility wrapper for expiring stale DM ACK entries."""
    dm_ack_tracker.cleanup_expired_acks()


async def on_contact_message(event: "Event") -> None:
    """Handle incoming direct messages from MeshCore library.

    NOTE: DMs are primarily handled by the packet processor via RX_LOG_DATA,
    which decrypts using our exported private key. This handler exists as a
    fallback for cases where:
    1. The private key couldn't be exported (firmware without ENABLE_PRIVATE_KEY_EXPORT)
    2. The packet processor couldn't match the sender to a known contact

    The packet processor handles: decryption, storage, broadcast, bot trigger.
    This handler adapts CONTACT_MSG_RECV payloads into the shared DM ingest
    workflow, which reconciles duplicates against the packet pipeline when possible.
    """
    from app.radio_sync import owned_pending_fetch_active

    if owned_pending_fetch_active():
        # Only the worker that issued get_msg may persist that response.
        return
    payload = event.payload

    from app.services.radio_job_worker import radio_job_scheduler
    from app.services.radio_jobs import RadioActivityKind

    radio_job_scheduler.record_activity(RadioActivityKind.CONTACT_MESSAGE_OBSERVED)
    # Skip CLI command responses (txt_type=1) - these are handled by the command endpoint
    txt_type = payload.get("txt_type", 0)
    if txt_type == 1:
        logger.debug("Skipping CLI response from %s (txt_type=1)", payload.get("pubkey_prefix"))
        return

    # Get full public key if available, otherwise use prefix
    sender_pubkey = payload.get("public_key") or payload.get("pubkey_prefix", "")
    received_at = int(time.time())

    context = await resolve_fallback_direct_message_context(
        sender_public_key=sender_pubkey,
        received_at=received_at,
        broadcast_fn=broadcast_event,
        contact_repository=ContactRepository,
        log=logger,
    )
    if context.skip_storage:
        logger.debug(
            "Skipping protected non-chat message from %s",
            context.conversation_key[:12],
        )
        return

    # Try to create or reconcile the message via the shared DM ingest service.
    ts = payload.get("sender_timestamp")
    sender_timestamp = ts if ts is not None else received_at
    path = payload.get("path")
    path_len = payload.get("path_len")
    sender_name = context.sender_name
    sender_key = context.sender_key
    signature = payload.get("signature")
    if (
        context.contact is not None
        and context.contact.type == CONTACT_TYPE_ROOM
        and txt_type == 2
        and isinstance(signature, str)
        and signature
    ):
        sender_name, sender_key = await resolve_direct_message_sender_metadata(
            sender_public_key=signature,
            received_at=received_at,
            broadcast_fn=broadcast_event,
            contact_repository=ContactRepository,
            log=logger,
        )
    message = await ingest_fallback_direct_message(
        conversation_key=context.conversation_key,
        text=payload.get("text", ""),
        sender_timestamp=sender_timestamp,
        received_at=received_at,
        path=path,
        path_len=path_len,
        txt_type=txt_type,
        signature=signature,
        sender_name=sender_name,
        sender_key=sender_key,
        broadcast_fn=broadcast_event,
        update_last_contacted_key=context.contact.public_key.lower() if context.contact else None,
    )

    if message is None:
        # Already handled by packet processor (or exact duplicate) - nothing more to do
        logger.debug(
            "DM from %s already processed by packet processor", context.conversation_key[:12]
        )
        return

    # If we get here, the packet processor didn't handle this message
    # (likely because private key export is not available)
    logger.debug(
        "DM from %s handled by event handler (fallback path)", context.conversation_key[:12]
    )


async def on_channel_message(event: "Event") -> None:
    """Ingest a decrypted Companion pending-channel event even without RX_LOG_DATA.

    The Companion delivers queued channel messages independently of raw RX logs.
    The shared channel writer uses the same SQL deduplication as raw processing.
    This handler does not initiate a second radio connection.
    """
    from app.radio_sync import _store_pending_channel_message, owned_pending_fetch_active
    from app.services.radio_runtime import radio_runtime

    # In a worker-owned get_msg round-trip its caller persists the returned
    # result. The SDK dispatcher also emits the response as an event.
    if owned_pending_fetch_active():
        return
    mc = radio_runtime.meshcore
    if mc is None or not radio_runtime.is_connected:
        logger.warning("Channel pending event received without an active radio context")
        return
    try:
        await _store_pending_channel_message(mc, event.payload)
    except Exception:
        logger.exception("Unable to ingest queued channel event")


async def on_rx_log_data(event: "Event") -> None:
    """Admit RX into one bounded worker without blocking the SDK dispatcher."""
    from app.services.rx_ingress import rx_ingress

    rx_ingress.submit(event.payload if isinstance(event.payload, dict) else {})


async def on_messages_waiting(event: "Event") -> None:
    """Coalesce Companion wakeups into the application's single worker."""
    from app.radio_sync import request_inbound_catchup

    request_inbound_catchup()


async def on_path_update(event: "Event") -> None:
    """Handle path update events."""
    from app.services.radio_job_worker import radio_job_scheduler
    from app.services.radio_jobs import RadioActivityKind

    radio_job_scheduler.record_activity(RadioActivityKind.PATH_UPDATE)
    payload = event.payload
    public_key = str(payload.get("public_key", "")).lower()
    pubkey_prefix = str(payload.get("pubkey_prefix", "")).lower()

    contact: Contact | None = None
    if public_key:
        logger.debug("Path update for %s", public_key[:12])
        contact = await ContactRepository.get_by_key(public_key)
    elif pubkey_prefix:
        # Legacy compatibility: older payloads may only include a prefix.
        logger.debug("Path update for prefix %s", pubkey_prefix)
        contact = await ContactRepository.get_by_key_prefix(pubkey_prefix)
    else:
        logger.debug("PATH_UPDATE missing public_key/pubkey_prefix, skipping")
        return

    if not contact:
        return

    # PATH_UPDATE is a serial control push event from firmware (not an RF packet).
    # Current meshcore payloads only include public_key for this event.
    # RF route/path bytes are handled via RX_LOG_DATA -> process_raw_packet,
    # so if path fields are absent here we treat this as informational only.
    path = payload.get("path")
    path_len = payload.get("path_len")
    path_hash_mode = payload.get("path_hash_mode")
    if path is None or path_len is None:
        logger.debug(
            "PATH_UPDATE for %s has no path payload, skipping DB update", contact.public_key[:12]
        )
        return

    try:
        normalized_path_len = int(path_len)
    except (TypeError, ValueError):
        logger.warning(
            "Invalid path_len in PATH_UPDATE for %s: %r", contact.public_key[:12], path_len
        )
        return

    normalized_path_hash_mode: int | None
    if path_hash_mode is None:
        # Legacy firmware/library payloads only support 1-byte hop hashes.
        normalized_path_hash_mode = -1 if normalized_path_len == -1 else 0
    else:
        try:
            normalized_path_hash_mode = int(path_hash_mode)
        except (TypeError, ValueError):
            logger.warning(
                "Invalid path_hash_mode in PATH_UPDATE for %s: %r",
                contact.public_key[:12],
                path_hash_mode,
            )
            normalized_path_hash_mode = None

    await ContactRepository.update_direct_path(
        contact.public_key,
        str(path),
        normalized_path_len,
        normalized_path_hash_mode,
        updated_at=int(time.time()),
    )


async def on_new_contact(event: "Event") -> None:
    """Handle new contact from radio's internal contact database.

    This is different from RF advertisements - these are contacts synced
    from the radio's stored contact list.
    """
    from app.services.radio_job_worker import radio_job_scheduler
    from app.services.radio_jobs import RadioActivityKind

    radio_job_scheduler.record_activity(RadioActivityKind.CONTACT_OBSERVED)
    payload = event.payload
    public_key = payload.get("public_key", "")

    if not public_key:
        logger.warning("Received new contact event with no public_key, skipping")
        return

    logger.debug("New contact: %s", public_key[:12])

    contact_upsert = ContactUpsert.from_radio_dict(public_key.lower(), payload, on_radio=False)

    # Block new contacts whose type is in discovery_blocked_types, matching
    # the same guard in _process_advertisement.  Existing contacts (already
    # in the DB) are always updated.
    existing = await ContactRepository.get_by_key(public_key.lower())
    contact_type = contact_upsert.type or 0
    if existing is None and contact_type > 0:
        from app.repository import AppSettingsRepository

        settings = await AppSettingsRepository.get()
        if contact_type in settings.discovery_blocked_types:
            logger.debug(
                "Skipping new contact %s: type %d is in discovery_blocked_types",
                public_key[:12],
                contact_type,
            )
            return

    # Intentionally do not set first_seen or last_seen here: NEW_CONTACT
    # fires from the radio's stored contact DB, not an RF observation.
    # Both first_seen and last_seen are RF-only timestamps — they track
    # the first and most recent time we actually heard this pubkey over
    # the air (adverts, messages, path updates). Contacts synced from the
    # radio's internal DB without any RF activity stay NULL until a real
    # RF observation fills them in.
    await ContactRepository.upsert(contact_upsert)
    promoted_keys = await promote_prefix_contacts_for_contact(
        public_key=public_key,
        log=logger,
    )

    adv_name = payload.get("adv_name")
    await record_contact_name_and_reconcile(
        public_key=public_key,
        contact_name=adv_name,
        timestamp=int(time.time()),
        log=logger,
    )

    # Read back from DB so the broadcast includes all fields (last_contacted,
    # last_read_at, etc.) matching the REST Contact shape exactly.
    db_contact = await ContactRepository.get_by_key(public_key)
    broadcast_event(
        "contact",
        (
            db_contact.model_dump()
            if db_contact
            else Contact(**contact_upsert.model_dump(exclude_none=True)).model_dump()
        ),
    )
    if db_contact:
        for old_key in promoted_keys:
            broadcast_event(
                "contact_resolved",
                {
                    "previous_public_key": old_key,
                    "contact": db_contact.model_dump(),
                },
            )


async def on_ack(event: "Event") -> None:
    """Handle ACK events for direct messages."""
    payload = event.payload
    ack_code = payload.get("code", "")

    if not ack_code:
        logger.debug("Received ACK with no code")
        return

    from app.services.radio_job_worker import radio_job_scheduler
    from app.services.radio_jobs import RadioActivityKind

    radio_job_scheduler.record_activity(RadioActivityKind.ACK_OBSERVED)
    logger.debug("Received ACK with code %s", ack_code)
    matched = await apply_dm_ack_code(ack_code, broadcast_fn=broadcast_event)
    if matched:
        logger.info("ACK received for code %s", ack_code)
    else:
        logger.debug("ACK code %s does not match any pending messages", ack_code)


def register_event_handlers(meshcore) -> None:
    """Register event handlers with the MeshCore instance.

    ADVERTISEMENT is handled by raw RX; CHANNEL_MSG_RECV is subscribed
    because dequeued Companion messages may have no corresponding raw RX.

    This function is safe to call multiple times (e.g., after reconnect).
    Existing handlers are unsubscribed before new ones are registered.
    """
    global _active_subscriptions

    # Unsubscribe existing handlers to prevent duplication after reconnects.
    # Try/except handles the case where the old dispatcher is in a bad state
    # (e.g., after reconnect with a new MeshCore instance).
    for sub in _active_subscriptions:
        try:
            sub.unsubscribe()
        except Exception:
            pass  # Old dispatcher may be gone, that's fine
    _active_subscriptions.clear()

    # Register handlers and track subscriptions
    _active_subscriptions.append(meshcore.subscribe(EventType.CONTACT_MSG_RECV, on_contact_message))
    _active_subscriptions.append(meshcore.subscribe(EventType.CHANNEL_MSG_RECV, on_channel_message))
    _active_subscriptions.append(meshcore.subscribe(EventType.RX_LOG_DATA, on_rx_log_data))
    _active_subscriptions.append(meshcore.subscribe(EventType.PATH_UPDATE, on_path_update))
    _active_subscriptions.append(meshcore.subscribe(EventType.NEW_CONTACT, on_new_contact))
    _active_subscriptions.append(meshcore.subscribe(EventType.ACK, on_ack))
    _active_subscriptions.append(
        meshcore.subscribe(EventType.MESSAGES_WAITING, on_messages_waiting)
    )
    from app.services.radio_runtime import radio_runtime

    generation = radio_runtime.radio_generation

    async def contact_evicted(event: "Event") -> None:
        await on_radio_contact_deleted(
            event,
            generation=generation,
            source=meshcore,
            received_at=time.monotonic(),
        )

    async def contacts_full(event: "Event") -> None:
        await on_radio_contacts_full(event, generation=generation, source=meshcore)

    _active_subscriptions.append(meshcore.subscribe(EventType.CONTACT_DELETED, contact_evicted))
    _active_subscriptions.append(meshcore.subscribe(EventType.CONTACTS_FULL, contacts_full))
    logger.info("Event handlers registered")
