"""Validated virtual Companion direct sends through the canonical send service."""

import asyncio
import logging
import time
from collections import OrderedDict
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any, Protocol

from fastapi import HTTPException

from app.event_handlers import track_pending_ack
from app.models import Contact, Message
from app.radio import RadioDisconnectedError, RadioOperationBusyError
from app.repository.contacts import AmbiguousPublicKeyPrefixError, ContactRepository
from app.repository.messages import MessageRepository
from app.services.message_send import (
    DirectMessageSendOutcome,
    send_direct_message_to_contact,
)
from app.services.radio_runtime import radio_runtime
from app.websocket import broadcast_event

from .dispatch import CommandDispatcher, CommandResponse, DispatchContext

logger = logging.getLogger(__name__)

CMD_SEND_TXT_MSG = 0x02
RESP_CODE_ERR = 0x01
RESP_CODE_SENT = 0x06
PUSH_CODE_SEND_CONFIRMED = 0x82
ERR_CODE_UNSUPPORTED_CMD = 0x01
ERR_CODE_NOT_FOUND = 0x02
ERR_CODE_TABLE_FULL = 0x03
ERR_CODE_BAD_STATE = 0x04
ERR_CODE_ILLEGAL_ARG = 0x06
TXT_TYPE_PLAIN = 0
MAX_COMPLETED_SENDS = 512


class DirectContactRepository(Protocol):
    async def get_by_key_or_prefix(self, key_or_prefix: str) -> Contact | None: ...


class DirectMessageRepository(Protocol):
    async def get_by_content(
        self,
        msg_type: str,
        conversation_key: str,
        text: str,
        sender_timestamp: int | None,
        outgoing: bool | None = None,
    ) -> Message | None: ...


SendService = Callable[..., Awaitable[Any]]


@dataclass(frozen=True, slots=True)
class VirtualDirectSendResult:
    response: bytes
    ack_code: str | None = None
    message_id: int | None = None
    immediate_ack: bytes | None = None
    cacheable: bool = True


class VirtualCompanionDirectSender:
    """One shared, generation-scoped idempotency coordinator for all clients."""

    def __init__(
        self,
        *,
        contact_repository: DirectContactRepository = ContactRepository,
        message_repository: DirectMessageRepository = MessageRepository,
        runtime=radio_runtime,
        send_service: SendService = send_direct_message_to_contact,
        broadcast_fn=broadcast_event,
        track_ack_fn=track_pending_ack,
        now_fn=time.time,
    ) -> None:
        self._contacts = contact_repository
        self._messages = message_repository
        self._runtime = runtime
        self._send_service = send_service
        self._broadcast = broadcast_fn
        self._track_ack = track_ack_fn
        self._now = now_fn
        self._inflight: dict[tuple[int, str, int, str], asyncio.Task[VirtualDirectSendResult]] = {}
        self._completed: OrderedDict[tuple[int, str, int, str], VirtualDirectSendResult] = (
            OrderedDict()
        )

    async def send_direct(self, payload: bytes, context: DispatchContext) -> CommandResponse:
        decoded = decode_direct_send(payload)
        if decoded is None:
            return _error(ERR_CODE_ILLEGAL_ARG)
        txt_type, attempt, sender_timestamp, prefix, text = decoded
        if txt_type != TXT_TYPE_PLAIN:
            return _error(ERR_CODE_UNSUPPORTED_CMD)
        if attempt != 0:
            return _error(ERR_CODE_BAD_STATE)
        if context.identity_generation is None:
            return _error(ERR_CODE_BAD_STATE)

        try:
            contact = await self._contacts.get_by_key_or_prefix(prefix)
        except AmbiguousPublicKeyPrefixError:
            return _error(ERR_CODE_NOT_FOUND)
        if contact is None or not _valid_resolved_key(contact.public_key, prefix):
            return _error(ERR_CODE_NOT_FOUND)

        signature = (
            context.identity_generation,
            contact.public_key.lower(),
            sender_timestamp,
            text,
        )
        result = self._completed.get(signature)
        if result is None:
            task = self._inflight.get(signature)
            if task is None:
                task = asyncio.create_task(
                    self._send_once(contact, sender_timestamp, text),
                    name="virtual-companion-direct-send",
                )
                self._inflight[signature] = task
                task.add_done_callback(lambda done, key=signature: self._finish(key, done))
            result = await asyncio.shield(task)

        if result.ack_code is not None and result.message_id is not None:
            context.pending_virtual_acks[result.ack_code] = result.message_id
        if result.immediate_ack is not None and result.ack_code is not None:
            context.pending_virtual_acks.pop(result.ack_code, None)
            return (result.response, result.immediate_ack)
        return result.response

    def _finish(
        self,
        signature: tuple[int, str, int, str],
        task: asyncio.Task[VirtualDirectSendResult],
    ) -> None:
        if self._inflight.get(signature) is task:
            self._inflight.pop(signature, None)
        if task.cancelled():
            return
        try:
            result = task.result()
        except Exception:
            return
        if result.cacheable:
            self._completed[signature] = result
            self._completed.move_to_end(signature)
            while len(self._completed) > MAX_COMPLETED_SENDS:
                self._completed.popitem(last=False)

    async def _send_once(
        self, contact, sender_timestamp: int, text: str
    ) -> VirtualDirectSendResult:
        existing = await self._messages.get_by_content(
            "PRIV",
            contact.public_key.lower(),
            text,
            sender_timestamp,
            outgoing=True,
        )
        if existing is not None:
            return VirtualDirectSendResult(_error(ERR_CODE_BAD_STATE))
        try:
            self._runtime.require_connected()
            outcome = await self._send_service(
                contact=contact,
                text=text,
                radio_manager=self._runtime,
                broadcast_fn=self._broadcast,
                track_pending_ack_fn=self._track_ack,
                now_fn=self._now,
                requested_sender_timestamp=sender_timestamp,
                strict_sender_timestamp=True,
                schedule_retries=False,
                return_protocol_outcome=True,
                message_repository=self._messages,
                contact_repository=self._contacts,
            )
        except RadioOperationBusyError:
            return VirtualDirectSendResult(_error(ERR_CODE_TABLE_FULL), cacheable=False)
        except (RadioDisconnectedError, HTTPException) as exc:
            if isinstance(exc, HTTPException) and exc.status_code == 422:
                return VirtualDirectSendResult(_error(ERR_CODE_TABLE_FULL), cacheable=False)
            return VirtualDirectSendResult(
                _error(ERR_CODE_BAD_STATE),
                cacheable=isinstance(exc, HTTPException) and exc.status_code == 408,
            )
        except Exception:
            logger.exception("Virtual Companion direct send failed")
            return VirtualDirectSendResult(_error(ERR_CODE_BAD_STATE))

        if not isinstance(outcome, DirectMessageSendOutcome) or outcome.protocol is None:
            return VirtualDirectSendResult(_error(ERR_CODE_BAD_STATE))
        protocol = outcome.protocol
        response = (
            bytes((RESP_CODE_SENT, protocol.route_type))
            + protocol.expected_ack
            + protocol.suggested_timeout_ms.to_bytes(4, "little")
        )
        ack_code = protocol.expected_ack.hex()
        immediate_ack = None
        if outcome.immediate_ack_trip_time_ms is not None:
            immediate_ack = (
                bytes((PUSH_CODE_SEND_CONFIRMED,))
                + protocol.expected_ack
                + outcome.immediate_ack_trip_time_ms.to_bytes(4, "little")
            )
        return VirtualDirectSendResult(response, ack_code, outcome.message.id, immediate_ack)


def decode_direct_send(payload: bytes) -> tuple[int, int, int, str, str] | None:
    """Decode the exact firmware command layout without lossy UTF-8 replacement."""
    if not 14 <= len(payload) <= 176 or payload[0] != CMD_SEND_TXT_MSG:
        return None
    txt_type = payload[1]
    attempt = payload[2]
    sender_timestamp = int.from_bytes(payload[3:7], "little")
    prefix = payload[7:13].hex()
    try:
        text = payload[13:].decode("utf-8")
    except UnicodeDecodeError:
        return None
    if not text or "\0" in text:
        return None
    return txt_type, attempt, sender_timestamp, prefix, text


def register_direct_send_commands(
    dispatcher: CommandDispatcher,
    adapter: VirtualCompanionDirectSender | None = None,
) -> VirtualCompanionDirectSender:
    adapter = adapter or VirtualCompanionDirectSender()
    dispatcher.register(CMD_SEND_TXT_MSG, adapter.send_direct, min_length=14, max_length=176)
    return adapter


def _valid_resolved_key(public_key: str, requested_prefix: str) -> bool:
    if len(public_key) != 64 or not public_key.lower().startswith(requested_prefix):
        return False
    try:
        return len(bytes.fromhex(public_key)) == 32
    except ValueError:
        return False


def _error(code: int) -> bytes:
    return bytes((RESP_CODE_ERR, code))
