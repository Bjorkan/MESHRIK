"""Hardware-independent event correlation and late-response regression tests (#40)."""

from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

import pytest
from meshcore import EventType

from app.services.radio_job_scheduler import RadioJobScheduler
from app.services.radio_jobs import RadioJobKind, RadioJobResult, RadioJobState
from app.services.radio_response_tracker import (
    RadioResponseTracker,
    ResponseKind,
    ResponseReservationConflict,
)


class RadioEvents:
    def __init__(self):
        self.subscriptions = []

    def subscribe(self, event_type, callback, attribute_filters=None):
        entry = [event_type, callback, attribute_filters, True]
        self.subscriptions.append(entry)

        def unsubscribe():
            entry[3] = False

        return SimpleNamespace(unsubscribe=unsubscribe)

    def emit(self, event_type, **payload):
        for etype, callback, filters, active in list(self.subscriptions):
            if (
                active
                and etype == event_type
                and all(payload.get(k) == v for k, v in (filters or {}).items())
            ):
                callback(SimpleNamespace(type=event_type, payload=payload))

    def active_count(self):
        return sum(item[3] for item in self.subscriptions)


@pytest.mark.asyncio
async def test_early_login_and_unrelated_ack_can_complete_while_other_job_executes():
    scheduler = RadioJobScheduler()
    tracker = RadioResponseTracker(scheduler)
    mc = RadioEvents()
    login = scheduler.submit(RadioJobKind.REPEATER_LOGIN)
    dm = scheduler.submit(RadioJobKind.DIRECT_MESSAGE)
    unrelated = scheduler.submit(RadioJobKind.RADIO_QUERY)
    login_wait = tracker.reserve(
        login.id, kind=ResponseKind.REPEATER_LOGIN, target="aabbcc", meshcore=mc
    )
    dm_wait = tracker.reserve(dm.id, kind=ResponseKind.DM_ACK, ack_code="a1b2c3d4", message_id=42)
    assert scheduler.take_next().id == login.id
    # An event delivered before send() returns cannot be lost.
    mc.emit(EventType.LOGIN_SUCCESS, pubkey_prefix="aabbcc")
    assert await login_wait.wait(0.01) == RadioJobResult.RESPONSE_RECEIVED
    scheduler.transition(login.id, RadioJobState.AWAITING_RESPONSE)
    assert scheduler.get(login.id).state == RadioJobState.COMPLETED

    assert scheduler.take_next().id == dm.id
    scheduler.transition(dm.id, RadioJobState.AWAITING_ACK)
    # Another command runs while the DM is waiting.
    assert scheduler.take_next().id == unrelated.id
    tracker.notify_ack("unrelated", 42)
    tracker.notify_ack("a1b2c3d4", 999)
    assert not dm_wait.future.done()
    tracker.notify_ack("a1b2c3d4", 42)
    assert scheduler.get(dm.id).state == RadioJobState.COMPLETED
    assert await dm_wait.wait(0.01) == RadioJobResult.ACK_RECEIVED
    scheduler.transition(unrelated.id, RadioJobState.COMPLETED)
    assert mc.active_count() == 0
    tracker.shutdown()


@pytest.mark.asyncio
async def test_login_collision_fenced_until_connection_generation_changes():
    scheduler = RadioJobScheduler()
    tracker = RadioResponseTracker(scheduler)
    mc = RadioEvents()
    first = scheduler.submit(RadioJobKind.REPEATER_LOGIN)
    pending = tracker.reserve(
        first.id, kind=ResponseKind.REPEATER_LOGIN, target="abcd", meshcore=mc
    )
    second = scheduler.submit(RadioJobKind.REPEATER_LOGIN)
    with pytest.raises(ResponseReservationConflict):
        tracker.reserve(second.id, kind=ResponseKind.REPEATER_LOGIN, target="abcd", meshcore=mc)
    assert scheduler.take_next().id == first.id
    scheduler.transition(first.id, RadioJobState.AWAITING_RESPONSE)
    assert await pending.wait(0.001) is None
    assert scheduler.get(first.id).state == RadioJobState.UNKNOWN
    assert mc.active_count() == 0
    # A late reply must NEVER be allowed to settle another job for this target.
    mc.emit(EventType.LOGIN_SUCCESS, pubkey_prefix="abcd")
    with pytest.raises(ResponseReservationConflict):
        tracker.reserve(second.id, kind=ResponseKind.REPEATER_LOGIN, target="abcd", meshcore=mc)
    scheduler.change_generation(1)
    new = scheduler.submit(RadioJobKind.REPEATER_LOGIN)
    next_pending = tracker.reserve(
        new.id, kind=ResponseKind.REPEATER_LOGIN, target="abcd", meshcore=mc
    )
    assert scheduler.take_next().id == new.id
    scheduler.transition(new.id, RadioJobState.AWAITING_RESPONSE)
    mc.emit(EventType.LOGIN_FAILED, pubkey_prefix="abcd")
    assert scheduler.get(new.id).state == RadioJobState.FAILED
    assert await next_pending.wait(0.01) == RadioJobResult.REJECTED
    tracker.shutdown()


@pytest.mark.asyncio
async def test_cli_exclusive_response_scope_blocks_dispatch_without_blocking_inbound():
    scheduler = RadioJobScheduler()
    tracker = RadioResponseTracker(scheduler)
    mc = RadioEvents()
    cli = scheduler.submit(RadioJobKind.RADIO_QUERY)
    dm = scheduler.submit(RadioJobKind.DIRECT_MESSAGE)
    pending = tracker.reserve(cli.id, kind=ResponseKind.CLI, target="abc123", meshcore=mc)
    with pytest.raises(ResponseReservationConflict):
        tracker.reserve(dm.id, kind=ResponseKind.CLI, target="other", meshcore=mc)
    assert scheduler.take_next(tracker.can_dispatch).id == cli.id
    scheduler.transition(cli.id, RadioJobState.AWAITING_RESPONSE)
    assert scheduler.take_next(tracker.can_dispatch) is None
    mc.emit(EventType.CONTACT_MSG_RECV, pubkey_prefix="other", txt_type=1)
    assert not pending.future.done()
    mc.emit(EventType.CONTACT_MSG_RECV, pubkey_prefix="abc123", txt_type=1)
    assert scheduler.get(cli.id).state == RadioJobState.COMPLETED
    assert scheduler.take_next(tracker.can_dispatch).id == dm.id
    tracker.shutdown()


@pytest.mark.asyncio
async def test_queued_cancel_and_generation_close_subscriptions_without_matching_late_events():
    scheduler = RadioJobScheduler()
    tracker = RadioResponseTracker(scheduler)
    mc = RadioEvents()
    first = scheduler.submit(RadioJobKind.REPEATER_LOGIN)
    pending = tracker.reserve(first.id, kind=ResponseKind.REPEATER_LOGIN, target="x", meshcore=mc)
    scheduler.request_cancellation(first.id)
    assert await pending.wait(0.01) is None
    assert mc.active_count() == 0
    # Queued cancellation before dispatch didn't transmit, so no target fence.
    second = scheduler.submit(RadioJobKind.REPEATER_LOGIN)
    second_pending = tracker.reserve(
        second.id, kind=ResponseKind.REPEATER_LOGIN, target="x", meshcore=mc
    )
    scheduler.change_generation(1)
    assert await second_pending.wait(0.01) is None
    assert mc.active_count() == 0
    mc.emit(EventType.LOGIN_SUCCESS, pubkey_prefix="x")
    assert scheduler.get(second.id).state == RadioJobState.FAILED
    tracker.shutdown()


@pytest.mark.asyncio
async def test_response_expiration_sweep_closes_waiter_and_prevents_late_reply():
    now = datetime(2026, 10, 10, tzinfo=UTC)
    scheduler = RadioJobScheduler(clock=lambda: now)
    tracker = RadioResponseTracker(scheduler)
    job = scheduler.submit(RadioJobKind.DIRECT_MESSAGE, response_timeout_seconds=2)
    pending = tracker.reserve(job.id, kind=ResponseKind.DM_ACK, ack_code="ff", message_id=13)
    scheduler.take_next()
    scheduler.transition(job.id, RadioJobState.AWAITING_ACK)
    scheduler.sweep(now + timedelta(seconds=3))
    assert await pending.wait(0.01) is None
    tracker.notify_ack("ff", 13)
    assert scheduler.get(job.id).state == RadioJobState.UNKNOWN
    tracker.shutdown()


@pytest.mark.asyncio
async def test_two_parallel_ack_waiters_ignore_cross_message_and_duplicate_ack():
    scheduler = RadioJobScheduler()
    tracker = RadioResponseTracker(scheduler)
    first = scheduler.submit(RadioJobKind.DIRECT_MESSAGE)
    second = scheduler.submit(RadioJobKind.DIRECT_MESSAGE)
    a = tracker.reserve(first.id, kind=ResponseKind.DM_ACK, ack_code="abc", message_id=71)
    b = tracker.reserve(second.id, kind=ResponseKind.DM_ACK, ack_code="def", message_id=72)
    scheduler.take_next()
    scheduler.transition(first.id, RadioJobState.AWAITING_ACK)
    scheduler.take_next()
    scheduler.transition(second.id, RadioJobState.AWAITING_ACK)
    tracker.notify_ack("abc", 72)
    assert not a.future.done() and not b.future.done()
    tracker.notify_ack("def", 72)
    tracker.notify_ack("def", 72)
    assert scheduler.get(second.id).version == 4
    assert scheduler.get(first.id).state == RadioJobState.AWAITING_ACK
    tracker.notify_ack("abc", 71)
    assert await a.wait(0.01) == RadioJobResult.ACK_RECEIVED
    assert await b.wait(0.01) == RadioJobResult.ACK_RECEIVED
    assert scheduler.get(first.id).state == RadioJobState.COMPLETED
    tracker.shutdown()


@pytest.mark.asyncio
async def test_user_unsubscribe_prevents_queued_dispatch_and_stops_post_send_wait():
    scheduler = RadioJobScheduler()
    tracker = RadioResponseTracker(scheduler)
    queued = scheduler.submit(RadioJobKind.REPEATER_LOGIN)
    pending = tracker.reserve(
        queued.id, kind=ResponseKind.REPEATER_LOGIN, target="abc", meshcore=RadioEvents()
    )
    pending.unsubscribe()
    assert scheduler.get(queued.id).state == RadioJobState.CANCELLED
    assert scheduler.take_next() is None

    waiting = scheduler.submit(RadioJobKind.DIRECT_MESSAGE)
    ack = tracker.reserve(waiting.id, kind=ResponseKind.DM_ACK, ack_code="cd", message_id=3)
    scheduler.take_next()
    scheduler.transition(waiting.id, RadioJobState.AWAITING_ACK)
    ack.unsubscribe()
    assert scheduler.get(waiting.id).state == RadioJobState.CANCELLED
    assert scheduler.get(waiting.id).result == RadioJobResult.STOPPED_WAITING
    tracker.notify_ack("cd", 3)
    assert scheduler.get(waiting.id).state == RadioJobState.CANCELLED
    tracker.shutdown()


@pytest.mark.asyncio
async def test_generation_provider_fences_stale_events_between_worker_polls():
    generation = 0
    scheduler = RadioJobScheduler()
    tracker = RadioResponseTracker(scheduler, generation_provider=lambda: generation)
    radio = RadioEvents()
    job = scheduler.submit(RadioJobKind.REPEATER_LOGIN)
    pending = tracker.reserve(job.id, kind=ResponseKind.REPEATER_LOGIN, target="x", meshcore=radio)
    scheduler.take_next()
    scheduler.transition(job.id, RadioJobState.AWAITING_RESPONSE)
    # No worker poll/explicit scheduler generation change occurred yet.
    generation = 1
    radio.emit(EventType.LOGIN_SUCCESS, pubkey_prefix="x")
    assert await pending.wait(0.01) is None
    assert scheduler.get(job.id).state == RadioJobState.UNKNOWN
    assert scheduler.generation == 1
    tracker.shutdown()


@pytest.mark.asyncio
async def test_response_capacity_and_successful_login_duplicate_fence():
    scheduler = RadioJobScheduler()
    tracker = RadioResponseTracker(scheduler, max_pending=1)
    radio = RadioEvents()
    first = scheduler.submit(RadioJobKind.REPEATER_LOGIN)
    second = scheduler.submit(RadioJobKind.REPEATER_LOGIN)
    pending = tracker.reserve(
        first.id, kind=ResponseKind.REPEATER_LOGIN, target="ABC", meshcore=radio
    )
    with pytest.raises(ResponseReservationConflict):
        tracker.reserve(second.id, kind=ResponseKind.REPEATER_LOGIN, target="else", meshcore=radio)
    scheduler.take_next()
    scheduler.transition(first.id, RadioJobState.AWAITING_RESPONSE)
    radio.emit(EventType.LOGIN_SUCCESS, pubkey_prefix="abc")
    radio.emit(EventType.LOGIN_SUCCESS, pubkey_prefix="abc")
    assert await pending.wait(0.01) == RadioJobResult.RESPONSE_RECEIVED
    assert scheduler.get(first.id).state == RadioJobState.COMPLETED
    with pytest.raises(ResponseReservationConflict):
        tracker.reserve(second.id, kind=ResponseKind.ROOM_LOGIN, target="abc", meshcore=radio)
    tracker.shutdown()
