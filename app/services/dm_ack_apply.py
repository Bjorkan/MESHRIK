"""Durable, idempotent ACK application; no correlation is popped before COMMIT."""
from app.services import dm_ack_persistence, dm_ack_tracker
from app.services.messages import BroadcastFn


async def apply_dm_ack_code(ack_code: str, *, broadcast_fn: BroadcastFn) -> bool:
    dm_ack_tracker.cleanup_expired_acks()
    # On write failure this peek leaves all codes available for replay.
    fallback = dm_ack_tracker.peek_pending_ack(ack_code)
    committed = await dm_ack_persistence.confirm(ack_code, fallback)
    if committed is None:
        dm_ack_tracker.buffer_unmatched_ack(ack_code)
        return False
    message_id, ack_count = committed
    dm_ack_tracker.clear_pending_acks_for_message(message_id)
    broadcast_fn("message_acked", {"message_id": message_id, "ack_count": ack_count})
    from app.services.radio_response_tracker import radio_response_tracker

    radio_response_tracker.notify_ack(ack_code, message_id)
    from app.services.message_send import cancel_direct_message_retry

    cancel_direct_message_retry(message_id)
    return True
