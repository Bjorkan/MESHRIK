"""S08 virtual Companion direct-send and genuine ACK lifecycle tests."""

import asyncio
import inspect
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

import pytest
from fastapi import HTTPException
from meshcore import EventType

from app.models import Contact, Message
from app.radio import RadioOperationBusyError
from app.repository.contacts import AmbiguousPublicKeyPrefixError, ContactRepository
from app.repository.messages import MessageRepository
from app.services import dm_ack_tracker
from app.services.message_send import (
    DirectMessageProtocolResult,
    DirectMessageSendOutcome,
    _extract_direct_message_protocol_result,
)
from app.services.virtual_companion.direct_send import (
    VirtualCompanionDirectSender,
    decode_direct_send,
)
from app.services.virtual_companion.server import VirtualCompanionServer
from app.services.virtual_companion.session import SessionState, VirtualCompanionSession

CONTACT_KEY = "22" * 32
PREFIX = bytes.fromhex(CONTACT_KEY)[:6]


def _command(
    text: str = "hello",
    *,
    txt_type: int = 0,
    attempt: int = 0,
    timestamp: int = 0x10203040,
    prefix: bytes = PREFIX,
) -> bytes:
    return (
        bytes((0x02, txt_type, attempt))
        + timestamp.to_bytes(4, "little")
        + prefix
        + text.encode("utf-8")
    )


def _message(message_id: int = 7, **changes) -> Message:
    values = {
        "id": message_id,
        "type": "PRIV",
        "conversation_key": CONTACT_KEY,
        "text": "hello",
        "sender_timestamp": 0x10203040,
        "received_at": 1,
        "outgoing": True,
    }
    values.update(changes)
    return Message(**values)


class FakeContacts:
    def __init__(self, contact=None, *, ambiguous=False):
        self.contact = contact
        self.ambiguous = ambiguous

    async def get_by_key_or_prefix(self, prefix):
        if self.ambiguous:
            raise AmbiguousPublicKeyPrefixError(prefix, [CONTACT_KEY, "23" * 32])
        return self.contact


class FakeMessages:
    def __init__(self, existing=None):
        self.existing = existing

    async def get_by_content(self, *_args, **_kwargs):
        return self.existing


class FakeRuntime:
    def __init__(self):
        self.require_connected = Mock()


def _outcome(*, immediate_trip=None, protocol=True):
    wire = DirectMessageProtocolResult(1, b"\xde\xad\xbe\xef", 0x01020304) if protocol else None
    return DirectMessageSendOutcome(_message(), wire, immediate_trip)


@pytest.mark.parametrize(
    "command,expected",
    [
        (_command("å"), (0, 0, 0x10203040, CONTACT_KEY[:12], "å")),
        (_command(txt_type=3), (3, 0, 0x10203040, CONTACT_KEY[:12], "hello")),
    ],
)
def test_golden_command_decode(command, expected):
    assert decode_direct_send(command) == expected


@pytest.mark.parametrize(
    "payload",
    [
        b"\x02" * 13,
        _command("")[:-1],
        _command("hello") + b"\xff",
        _command("hello\0hidden"),
        b"\x03" + _command()[1:],
        _command("x" * 164),
    ],
)
def test_malformed_lengths_utf8_nul_and_wrong_command_are_rejected(payload):
    assert decode_direct_send(payload) is None


@pytest.mark.asyncio
async def test_valid_send_returns_exact_real_sent_fields_and_no_service_retry():
    send_service = AsyncMock(return_value=_outcome())
    adapter = VirtualCompanionDirectSender(
        contact_repository=FakeContacts(Contact(public_key=CONTACT_KEY, name="Alice")),
        message_repository=FakeMessages(),
        runtime=FakeRuntime(),
        send_service=send_service,
        broadcast_fn=Mock(),
        track_ack_fn=Mock(return_value=False),
        now_fn=lambda: 99,
    )
    context = SessionState(identity_generation=4)
    response = await adapter.send_direct(_command(), context)
    assert response == b"\x06\x01\xde\xad\xbe\xef\x04\x03\x02\x01"
    assert context.pending_virtual_acks == {"deadbeef": 7}
    kwargs = send_service.await_args.kwargs
    assert kwargs["requested_sender_timestamp"] == 0x10203040
    assert kwargs["strict_sender_timestamp"] is True
    assert kwargs["schedule_retries"] is False
    assert kwargs["return_protocol_outcome"] is True


@pytest.mark.asyncio
async def test_cli_attempt_missing_ambiguous_and_unresolved_contacts_fail_closed():
    contact = Contact(public_key=CONTACT_KEY, name="Alice")
    adapter = VirtualCompanionDirectSender(
        contact_repository=FakeContacts(contact),
        message_repository=FakeMessages(),
        runtime=FakeRuntime(),
        send_service=AsyncMock(return_value=_outcome()),
    )
    context = SessionState(identity_generation=1)
    assert await adapter.send_direct(_command(txt_type=3), context) == b"\x01\x01"
    assert await adapter.send_direct(_command(attempt=1), context) == b"\x01\x04"
    assert await adapter.send_direct(_command(), SessionState()) == b"\x01\x04"

    for contacts in (
        FakeContacts(),
        FakeContacts(ambiguous=True),
        FakeContacts(Contact(public_key="22" * 6)),
    ):
        missing = VirtualCompanionDirectSender(
            contact_repository=contacts,
            message_repository=FakeMessages(),
            runtime=FakeRuntime(),
            send_service=AsyncMock(return_value=_outcome()),
        )
        assert await missing.send_direct(_command(), context) == b"\x01\x02"


@pytest.mark.asyncio
async def test_concurrent_clients_and_reconnect_share_one_idempotent_send():
    started = asyncio.Event()
    release = asyncio.Event()
    calls = 0

    async def send_service(**_kwargs):
        nonlocal calls
        calls += 1
        started.set()
        await release.wait()
        return _outcome()

    adapter = VirtualCompanionDirectSender(
        contact_repository=FakeContacts(Contact(public_key=CONTACT_KEY)),
        message_repository=FakeMessages(),
        runtime=FakeRuntime(),
        send_service=send_service,
    )
    contexts = (SessionState(identity_generation=9), SessionState(identity_generation=9))
    sends = [asyncio.create_task(adapter.send_direct(_command(), context)) for context in contexts]
    await started.wait()
    release.set()
    first, second = await asyncio.gather(*sends)
    reconnect = await adapter.send_direct(_command(), SessionState(identity_generation=9))
    assert first == second == reconnect
    assert calls == 1


@pytest.mark.asyncio
async def test_radio_generation_is_part_of_idempotency_identity():
    service = AsyncMock(return_value=_outcome())
    adapter = VirtualCompanionDirectSender(
        contact_repository=FakeContacts(Contact(public_key=CONTACT_KEY)),
        message_repository=FakeMessages(),
        runtime=FakeRuntime(),
        send_service=service,
    )
    await adapter.send_direct(_command(), SessionState(identity_generation=1))
    await adapter.send_direct(_command(), SessionState(identity_generation=2))
    assert service.await_count == 2


@pytest.mark.asyncio
async def test_lost_reply_does_not_cancel_or_repeat_rf_operation():
    started = asyncio.Event()
    release = asyncio.Event()
    calls = 0

    async def send_service(**_kwargs):
        nonlocal calls
        calls += 1
        started.set()
        await release.wait()
        return _outcome()

    adapter = VirtualCompanionDirectSender(
        contact_repository=FakeContacts(Contact(public_key=CONTACT_KEY)),
        message_repository=FakeMessages(),
        runtime=FakeRuntime(),
        send_service=send_service,
    )
    abandoned = asyncio.create_task(
        adapter.send_direct(_command(), SessionState(identity_generation=3))
    )
    await started.wait()
    abandoned.cancel()
    with pytest.raises(asyncio.CancelledError):
        await abandoned
    release.set()
    await asyncio.sleep(0)
    response = await adapter.send_direct(_command(), SessionState(identity_generation=3))
    assert response[0] == 0x06
    assert calls == 1


@pytest.mark.asyncio
async def test_uncertain_and_malformed_radio_results_never_claim_sent():
    for result in (HTTPException(408, "uncertain"), _outcome(protocol=False)):
        service = (
            AsyncMock(side_effect=result)
            if isinstance(result, Exception)
            else AsyncMock(return_value=result)
        )
        adapter = VirtualCompanionDirectSender(
            contact_repository=FakeContacts(Contact(public_key=CONTACT_KEY)),
            message_repository=FakeMessages(),
            runtime=FakeRuntime(),
            send_service=service,
        )
        context = SessionState(identity_generation=1)
        assert await adapter.send_direct(_command(), context) == b"\x01\x04"
        assert await adapter.send_direct(_command(), context) == b"\x01\x04"
        assert service.await_count == 1
        assert not context.pending_virtual_acks


@pytest.mark.asyncio
async def test_pre_dispatch_queue_rejection_is_safe_to_retry_without_claiming_sent():
    service = AsyncMock(side_effect=RadioOperationBusyError("full"))
    adapter = VirtualCompanionDirectSender(
        contact_repository=FakeContacts(Contact(public_key=CONTACT_KEY)),
        message_repository=FakeMessages(),
        runtime=FakeRuntime(),
        send_service=service,
    )
    context = SessionState(identity_generation=1)
    assert await adapter.send_direct(_command(), context) == b"\x01\x03"
    await asyncio.sleep(0)
    assert await adapter.send_direct(_command(), context) == b"\x01\x03"
    assert service.await_count == 2


@pytest.mark.parametrize(
    "payload",
    [
        {"type": 2, "expected_ack": b"1234", "suggested_timeout": 1},
        {"type": 0, "expected_ack": b"123", "suggested_timeout": 1},
        {"type": 0, "expected_ack": b"1234", "suggested_timeout": -1},
        {"type": 0, "expected_ack": b"1234"},
    ],
)
def test_malformed_firmware_sent_metadata_has_no_protocol_result(payload):
    event = SimpleNamespace(type=EventType.MSG_SENT, payload=payload)
    assert _extract_direct_message_protocol_result(event) is None


class NullWriter:
    def write(self, _data):
        pass

    async def drain(self):
        pass

    def close(self):
        pass

    async def wait_closed(self):
        pass


@pytest.mark.asyncio
async def test_ack_push_is_exact_committed_and_session_owned(test_db):
    message_id = await MessageRepository.create(
        "PRIV", "hello", 1, CONTACT_KEY, sender_timestamp=1, outgoing=True
    )
    assert message_id is not None
    async with test_db.tx() as conn:
        await conn.execute("UPDATE messages SET acked=1 WHERE id=?", (message_id,))

    server = VirtualCompanionServer(SimpleNamespace())
    owner = VirtualCompanionSession(None, NullWriter(), SimpleNamespace())
    other = VirtualCompanionSession(None, NullWriter(), SimpleNamespace())
    owner.state.pending_virtual_acks["deadbeef"] = message_id
    server._sessions.update((owner, other))
    await server.notify_send_confirmed("deadbeef", 0x01020304)
    assert await owner._next_outbound() == b"\x82\xde\xad\xbe\xef\x04\x03\x02\x01"
    assert other._outbox.empty()
    assert not owner.state.pending_virtual_acks


@pytest.mark.asyncio
async def test_host_ack_notifies_virtual_path_only_after_canonical_commit(test_db):
    from app.event_handlers import on_ack

    message_id = await MessageRepository.create(
        "PRIV", "hello", 1, CONTACT_KEY, sender_timestamp=1, outgoing=True
    )
    assert message_id is not None
    dm_ack_tracker.track_pending_ack("deadbeef", message_id, 10_000)
    with (
        patch("app.event_handlers.broadcast_event"),
        patch(
            "app.fanout.manager.fanout_manager.notify_virtual_companion_ack",
            new_callable=AsyncMock,
        ) as notify,
    ):
        await on_ack(SimpleNamespace(payload={"code": "deadbeef", "trip_time": 321}))
    ack_count, _paths = await MessageRepository.get_ack_and_paths(message_id)
    assert ack_count == 1
    notify.assert_awaited_once_with("deadbeef", 321)


@pytest.mark.asyncio
async def test_real_service_path_persists_once_and_sends_one_rf_message(test_db):
    contact = Contact(public_key=CONTACT_KEY, name="Alice", type=1)
    await ContactRepository.upsert(contact)
    sent = SimpleNamespace(
        type=EventType.MSG_SENT,
        payload={"type": 0, "expected_ack": b"\x01\x02\x03\x04", "suggested_timeout": 8000},
    )
    mc = SimpleNamespace(
        commands=SimpleNamespace(
            add_contact=AsyncMock(return_value=SimpleNamespace(type=EventType.OK)),
            send_msg=AsyncMock(return_value=sent),
        ),
        get_contact_by_key_prefix=Mock(return_value=contact.to_radio_dict()),
    )

    class Runtime:
        def require_connected(self):
            return mc

        async def run_radio_command(self, _name, command, **_options):
            return await command(mc)

    broadcasts = []
    adapter = VirtualCompanionDirectSender(
        runtime=Runtime(),
        broadcast_fn=lambda event, data, **_kwargs: broadcasts.append((event, data)),
        track_ack_fn=dm_ack_tracker.track_pending_ack,
        now_fn=lambda: 100,
    )
    try:
        response = await adapter.send_direct(_command(), SessionState(identity_generation=1))
        assert response == b"\x06\x00\x01\x02\x03\x04\x40\x1f\x00\x00"
        assert mc.commands.send_msg.await_count == 1
        stored = await MessageRepository.get_by_content(
            "PRIV", CONTACT_KEY, "hello", 0x10203040, outgoing=True
        )
        assert stored is not None and stored.send_status == "confirmed"
        assert sum(1 for event, _data in broadcasts if event == "message") == 1
    finally:
        dm_ack_tracker._pending_acks.clear()
        dm_ack_tracker._buffered_acks.clear()
        dm_ack_tracker._buffered_ack_trip_times.clear()


def test_adapter_has_no_raw_radio_or_sdk_command_path():
    import app.services.virtual_companion.direct_send as module

    source = inspect.getsource(module)
    assert ".commands" not in source
    assert "send_msg(" not in source
    assert "raw_radio_operation" not in source
    assert "send_direct_message_to_contact" in source
