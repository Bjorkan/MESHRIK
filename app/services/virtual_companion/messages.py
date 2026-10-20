"""Per-client virtual Companion inbox over durable MESHRIK messages."""

from typing import Protocol

from app.models import Message, MessagePath
from app.repository.messages import MessageRepository

from .channels import VirtualCompanionChannels
from .dispatch import CommandDispatcher, DispatchContext

CMD_SYNC_NEXT_MESSAGE = 0x0A
RESP_CODE_CONTACT_MSG_RECV = 0x07
RESP_CODE_CHANNEL_MSG_RECV = 0x08
RESP_CODE_NO_MORE_MESSAGES = 0x0A
RESP_CODE_CONTACT_MSG_RECV_V3 = 0x10
RESP_CODE_CHANNEL_MSG_RECV_V3 = 0x11
MAX_FRAME_SIZE = 176
DEFAULT_HISTORY_WINDOW = 200


class CompanionMessageRepository(Protocol):
    async def get_companion_initial_cursor(
        self, channel_keys: tuple[str, ...], history_limit: int
    ) -> int: ...

    async def get_companion_message_after(
        self, cursor_id: int, channel_keys: tuple[str, ...]
    ) -> Message | None: ...


class VirtualCompanionMessages:
    """Advance only the requesting client's monotonic database-ID cursor."""

    def __init__(
        self,
        channels: VirtualCompanionChannels,
        *,
        repository: CompanionMessageRepository = MessageRepository,
        history_window: int = DEFAULT_HISTORY_WINDOW,
    ) -> None:
        if history_window < 1:
            raise ValueError("history_window must be positive")
        self._channels = channels
        self._repository = repository
        self._history_window = history_window

    async def sync_next_message(self, _payload: bytes, context: DispatchContext) -> bytes:
        if not context.metadata.get("message_window_initialized"):
            context.message_cursor = await self._repository.get_companion_initial_cursor(
                self._channels.configured_keys, self._history_window
            )
            context.metadata["message_window_initialized"] = True

        while True:
            message = await self._repository.get_companion_message_after(
                context.message_cursor, self._channels.configured_keys
            )
            if message is None:
                return bytes((RESP_CODE_NO_MORE_MESSAGES,))
            context.message_cursor = message.id
            frame = encode_message(
                message,
                channel_index=self._channels.configured_index(message.conversation_key),
                protocol_version=context.protocol_version,
            )
            if frame is not None:
                return frame


def register_message_commands(
    dispatcher: CommandDispatcher,
    channels: VirtualCompanionChannels,
    adapter: VirtualCompanionMessages | None = None,
) -> VirtualCompanionMessages:
    adapter = adapter or VirtualCompanionMessages(channels)
    dispatcher.register(
        CMD_SYNC_NEXT_MESSAGE,
        adapter.sync_next_message,
        min_length=1,
        max_length=1,
    )
    return adapter


def encode_message(
    message: Message,
    *,
    channel_index: int | None,
    protocol_version: int | None,
) -> bytes | None:
    """Serialize only representations supported by the official Companion reader."""
    if (
        message.outgoing
        or message.sender_timestamp is not None
        and not 0 <= message.sender_timestamp <= 0xFFFFFFFF
    ):
        return None
    legacy = protocol_version is not None and protocol_version < 3
    path_status, snr_q4 = _radio_status(message.paths)
    timestamp = message.sender_timestamp or 0

    if message.type == "PRIV":
        # Companion's six-byte field identifies the DM peer (for room posts,
        # the room contact). A signed post's author remains the separate
        # four-byte signature prefix; substituting a resolved author key here
        # would silently move the message into the wrong conversation.
        sender_key = _full_key(message.conversation_key)
        if sender_key is None or not 0 <= message.txt_type <= 0xFF:
            return None
        signature = b""
        if message.txt_type == 2:
            if message.signature is None:
                return None
            try:
                signature = bytes.fromhex(message.signature)
            except ValueError:
                return None
            if len(signature) != 4:
                return None
        frame = bytearray(
            (RESP_CODE_CONTACT_MSG_RECV if legacy else RESP_CODE_CONTACT_MSG_RECV_V3,)
        )
        if not legacy:
            frame.extend((snr_q4 & 0xFF, 0, 0))
        frame.extend(bytes.fromhex(sender_key)[:6])
        frame.extend((path_status, message.txt_type))
        frame.extend(timestamp.to_bytes(4, "little"))
        frame.extend(signature)
        text = message.text
    elif message.type == "CHAN":
        if channel_index is None or not 0 <= message.txt_type <= 0xFF:
            return None
        frame = bytearray(
            (RESP_CODE_CHANNEL_MSG_RECV if legacy else RESP_CODE_CHANNEL_MSG_RECV_V3,)
        )
        if not legacy:
            frame.extend((snr_q4 & 0xFF, 0, 0))
        frame.extend((channel_index, path_status, message.txt_type))
        frame.extend(timestamp.to_bytes(4, "little"))
        text = _channel_body(message)
    else:
        return None

    frame.extend(_utf8_prefix(text, MAX_FRAME_SIZE - len(frame)))
    return bytes(frame)


def _radio_status(paths: list[MessagePath] | None) -> tuple[int, int]:
    """Encode retained RF evidence; use neutral metrics when evidence is absent."""
    if not paths:
        return 0xFF, 0
    observation = paths[-1]
    snr_q4 = 0 if observation.snr is None else round(observation.snr * 4)
    snr_q4 = min(127, max(-128, snr_q4))
    if observation.path_len is None or observation.path_len < 0:
        return 0xFF, snr_q4
    if observation.path_len == 0:
        return 0, snr_q4
    try:
        path_bytes = bytes.fromhex(observation.path)
    except ValueError:
        return 0xFF, snr_q4
    if len(path_bytes) % observation.path_len:
        return 0xFF, snr_q4
    hash_size = len(path_bytes) // observation.path_len
    if hash_size not in (1, 2, 3) or observation.path_len > 0x3F:
        return 0xFF, snr_q4
    return ((hash_size - 1) << 6) | observation.path_len, snr_q4


def _full_key(value: str | None) -> str | None:
    if value is None or len(value) != 64:
        return None
    try:
        return value.lower() if len(bytes.fromhex(value)) == 32 else None
    except ValueError:
        return None


def _channel_body(message: Message) -> str:
    if message.sender_name:
        prefix = f"{message.sender_name}: "
        if message.text.startswith(prefix):
            return message.text[len(prefix) :]
    return message.text


def _utf8_prefix(value: str, width: int) -> bytes:
    encoded = value.encode("utf-8")[:width]
    while encoded:
        try:
            encoded.decode("utf-8")
            return encoded
        except UnicodeDecodeError:
            encoded = encoded[:-1]
    return b""
