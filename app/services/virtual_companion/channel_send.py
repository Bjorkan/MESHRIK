"""Virtual channel text sends through stable slots and the canonical worker."""

import asyncio
import hashlib
import logging
import time
from collections import OrderedDict
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any, Protocol

from fastapi import HTTPException

from app.models import Channel, Message
from app.radio import RadioDisconnectedError, RadioOperationBusyError
from app.repository.channels import ChannelRepository
from app.repository.messages import MessageRepository
from app.services.message_send import SCOPE_UNSET, send_channel_message_to_channel
from app.services.radio_runtime import radio_runtime
from app.websocket import broadcast_error, broadcast_event

from .channels import VirtualCompanionChannels
from .dispatch import CommandDispatcher, DispatchContext

logger = logging.getLogger(__name__)

CMD_SEND_CHANNEL_TXT_MSG = 0x03
RESP_CODE_OK = 0x00
RESP_CODE_ERR = 0x01
ERR_CODE_UNSUPPORTED_CMD = 0x01
ERR_CODE_NOT_FOUND = 0x02
ERR_CODE_TABLE_FULL = 0x03
ERR_CODE_BAD_STATE = 0x04
ERR_CODE_ILLEGAL_ARG = 0x06
TXT_TYPE_PLAIN = 0
PHYSICAL_SEND_SLOT_PREFERENCE = 0
MAX_COMPLETED_SENDS = 512
IDEMPOTENCY_RETENTION_SECONDS = 24 * 60 * 60


class SendChannelRepository(Protocol):
    async def get_by_key(self, key: str) -> Channel | None: ...


class SendMessageRepository(Protocol):
    async def get_companion_outgoing_channel(
        self, channel_key: str, text: str, sender_timestamp: int
    ) -> Message | None: ...

    async def reserve_companion_channel_send(
        self,
        *,
        identity_key: str,
        virtual_index: int,
        sender_timestamp: int,
        text_hash: str,
        created_at: int,
        retention_seconds: int,
    ) -> bool: ...

    async def finish_companion_channel_send(
        self,
        *,
        identity_key: str,
        virtual_index: int,
        sender_timestamp: int,
        text_hash: str,
        status: str,
    ) -> None: ...

    async def release_companion_channel_send(
        self,
        *,
        identity_key: str,
        virtual_index: int,
        sender_timestamp: int,
        text_hash: str,
    ) -> None: ...


SendService = Callable[..., Awaitable[Any]]


@dataclass(frozen=True, slots=True)
class VirtualChannelSendResult:
    response: bytes
    cacheable: bool = True


class VirtualCompanionChannelSender:
    """Resolve virtual slots once and single-flight each logical app message."""

    def __init__(
        self,
        channels: VirtualCompanionChannels,
        *,
        channel_repository: SendChannelRepository = ChannelRepository,
        message_repository: SendMessageRepository = MessageRepository,
        runtime=radio_runtime,
        send_service: SendService = send_channel_message_to_channel,
        broadcast_fn=broadcast_event,
        error_broadcast_fn=broadcast_error,
        now_fn=time.time,
    ) -> None:
        self._channels = channels
        self._channel_repository = channel_repository
        self._messages = message_repository
        self._runtime = runtime
        self._send_service = send_service
        self._broadcast = broadcast_fn
        self._broadcast_error = error_broadcast_fn
        self._now = now_fn
        self._inflight: dict[tuple[str, str, int, str], asyncio.Task[VirtualChannelSendResult]] = {}
        self._completed: OrderedDict[tuple[str, str, int, str], VirtualChannelSendResult] = (
            OrderedDict()
        )

    async def send_channel(self, payload: bytes, context: DispatchContext) -> bytes:
        decoded = decode_channel_send(payload)
        if decoded is None:
            return _error(ERR_CODE_ILLEGAL_ARG)
        txt_type, virtual_index, sender_timestamp, text = decoded
        if txt_type != TXT_TYPE_PLAIN:
            return _error(ERR_CODE_UNSUPPORTED_CMD)
        identity_key = context.identity_public_key
        if context.identity_generation is None or not _valid_identity(identity_key):
            return _error(ERR_CODE_BAD_STATE)
        assert identity_key is not None

        virtual_slot = await self._channels.resolve_slot(virtual_index)
        if virtual_slot is None:
            return _error(ERR_CODE_NOT_FOUND)
        channel = await self._channel_repository.get_by_key(virtual_slot.key)
        if channel is None or channel.key.upper() != virtual_slot.key:
            return _error(ERR_CODE_NOT_FOUND)

        signature = (
            identity_key,
            virtual_slot.key,
            sender_timestamp,
            text,
        )
        result = self._completed.get(signature)
        if result is None:
            task = self._inflight.get(signature)
            if task is None:
                task = asyncio.create_task(
                    self._send_once(
                        channel,
                        identity_key=identity_key,
                        virtual_index=virtual_index,
                        sender_timestamp=sender_timestamp,
                        text=text,
                    ),
                    name="virtual-companion-channel-send",
                )
                self._inflight[signature] = task
                task.add_done_callback(lambda done, key=signature: self._finish(key, done))
            result = await asyncio.shield(task)
        return result.response

    def _finish(
        self,
        signature: tuple[str, str, int, str],
        task: asyncio.Task[VirtualChannelSendResult],
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

    async def _durable_duplicate(self, channel_key: str, sender_timestamp: int, text: str) -> bool:
        return (
            await self._messages.get_companion_outgoing_channel(channel_key, text, sender_timestamp)
            is not None
        )

    async def _send_once(
        self,
        channel: Channel,
        *,
        identity_key: str,
        virtual_index: int,
        sender_timestamp: int,
        text: str,
    ) -> VirtualChannelSendResult:
        channel_key = channel.key.upper()
        try:
            key_bytes = bytes.fromhex(channel_key)
        except ValueError:
            return VirtualChannelSendResult(_error(ERR_CODE_NOT_FOUND))
        if len(key_bytes) != 16:
            return VirtualChannelSendResult(_error(ERR_CODE_NOT_FOUND))

        text_hash = hashlib.sha256(text.encode("utf-8")).hexdigest()
        reservation = {
            "identity_key": identity_key,
            "virtual_index": virtual_index,
            "sender_timestamp": sender_timestamp,
            "text_hash": text_hash,
        }
        reserved = await self._messages.reserve_companion_channel_send(
            **reservation,
            created_at=int(self._now()),
            retention_seconds=IDEMPOTENCY_RETENTION_SECONDS,
        )
        if not reserved:
            return VirtualChannelSendResult(_error(ERR_CODE_BAD_STATE))
        if await self._durable_duplicate(channel_key, sender_timestamp, text):
            await self._messages.finish_companion_channel_send(**reservation, status="uncertain")
            return VirtualChannelSendResult(_error(ERR_CODE_BAD_STATE))

        try:
            self._runtime.require_connected()
            await self._send_service(
                channel=channel,
                channel_key_upper=channel_key,
                key_bytes=key_bytes,
                text=text,
                radio_manager=self._runtime,
                broadcast_fn=self._broadcast,
                error_broadcast_fn=self._broadcast_error,
                now_fn=self._now,
                temp_radio_slot=PHYSICAL_SEND_SLOT_PREFERENCE,
                flood_scope_override=SCOPE_UNSET,
                requested_sender_timestamp=sender_timestamp,
                strict_sender_timestamp=True,
                message_repository=self._messages,
            )
        except RadioOperationBusyError:
            await self._messages.release_companion_channel_send(**reservation)
            return VirtualChannelSendResult(_error(ERR_CODE_TABLE_FULL), cacheable=False)
        except (RadioDisconnectedError, HTTPException) as exc:
            durable = await self._durable_duplicate(channel_key, sender_timestamp, text)
            uncertain = durable or isinstance(exc, HTTPException) and exc.status_code == 408
            if uncertain:
                await self._messages.finish_companion_channel_send(
                    **reservation, status="uncertain"
                )
            else:
                await self._messages.release_companion_channel_send(**reservation)
            if isinstance(exc, HTTPException) and exc.status_code == 422:
                return VirtualChannelSendResult(_error(ERR_CODE_TABLE_FULL), cacheable=durable)
            return VirtualChannelSendResult(
                _error(ERR_CODE_BAD_STATE),
                cacheable=uncertain,
            )
        except Exception:
            await self._messages.finish_companion_channel_send(**reservation, status="uncertain")
            logger.exception("Virtual Companion channel send failed")
            return VirtualChannelSendResult(_error(ERR_CODE_BAD_STATE))
        await self._messages.finish_companion_channel_send(**reservation, status="ok")
        return VirtualChannelSendResult(bytes((RESP_CODE_OK,)))


def decode_channel_send(payload: bytes) -> tuple[int, int, int, str] | None:
    """Decode only firmware-compatible, non-empty channel text frames."""
    if not 8 <= len(payload) <= 176 or payload[0] != CMD_SEND_CHANNEL_TXT_MSG:
        return None
    txt_type = payload[1]
    virtual_index = payload[2]
    sender_timestamp = int.from_bytes(payload[3:7], "little")
    try:
        text = payload[7:].decode("utf-8")
    except UnicodeDecodeError:
        return None
    if not text or "\0" in text:
        return None
    return txt_type, virtual_index, sender_timestamp, text


def register_channel_send_commands(
    dispatcher: CommandDispatcher,
    channels: VirtualCompanionChannels,
    adapter: VirtualCompanionChannelSender | None = None,
) -> VirtualCompanionChannelSender:
    adapter = adapter or VirtualCompanionChannelSender(channels)
    dispatcher.register(
        CMD_SEND_CHANNEL_TXT_MSG,
        adapter.send_channel,
        min_length=8,
        max_length=176,
    )
    return adapter


def _error(code: int) -> bytes:
    return bytes((RESP_CODE_ERR, code))


def _valid_identity(value: str | None) -> bool:
    if value is None or len(value) != 64:
        return False
    try:
        return len(bytes.fromhex(value)) == 32
    except ValueError:
        return False
