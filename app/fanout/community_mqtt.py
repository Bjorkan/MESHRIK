"""Community MQTT publisher for sharing raw packets with the MeshCore community.

Publishes raw packet data to mqtt-us-v1.letsmesh.net using the protocol
defined by meshcore-packet-capture (https://github.com/agessaman/meshcore-packet-capture).

Authentication uses Ed25519 JWT tokens signed with the radio's private key.
This module is independent from the private MqttPublisher in app/mqtt.py.
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import math
import re
import ssl
import time
from datetime import UTC, datetime
from typing import Any, Protocol

import aiomqtt

from app.fanout.community_topics import (
    broker_retains,
    community_topic,
    error_subscriptions,
    validate_profile,
)
from app.fanout.mqtt_base import BaseMqttPublisher
from app.keystore import ed25519_sign_expanded
from app.path_utils import calculate_packet_hash, parse_packet_envelope, split_path_hex
from app.version_info import get_app_build_info

logger = logging.getLogger(__name__)

_DEFAULT_BROKER = "mqtt-us-v1.letsmesh.net"
_DEFAULT_PORT = 443  # Community protocol uses WSS on port 443 by default
_CLIENT_ID = "MESHRIK"

# JWT lifetime kept under 1 hour for compatibility with services that reject
# tokens with exp > 3600s from iat (e.g. Waev.app).  Proactive renewal
# reconnects 5 minutes before expiry.
_TOKEN_LIFETIME = 3300  # 55 minutes
_TOKEN_RENEWAL_THRESHOLD = _TOKEN_LIFETIME - 300  # 50 minutes

# Periodic status republish interval (matches meshcore-packet-capture reference)
_STATS_REFRESH_INTERVAL = 300  # 5 minutes
_STATS_MIN_CACHE_SECS = 60  # Don't re-fetch stats within 60s

# Route type mapping: bottom 2 bits of first byte
_ROUTE_MAP = {0: "F", 1: "F", 2: "D", 3: "T"}


def _format_utc_timestamp(dt: datetime | None = None) -> str:
    """Return an ISO-8601 UTC timestamp accepted by community observers."""
    current = (
        dt.replace(tzinfo=UTC)
        if dt is not None and dt.tzinfo is None
        else (dt.astimezone(UTC) if dt is not None else datetime.now(UTC))
    )
    return current.isoformat().replace("+00:00", "Z")


class CommunityMqttSettings(Protocol):
    """Attributes expected on the settings object for the community MQTT publisher."""

    community_mqtt_enabled: bool
    community_mqtt_broker_host: str
    community_mqtt_broker_port: int
    community_mqtt_transport: str
    community_mqtt_use_tls: bool
    community_mqtt_tls_verify: bool
    community_mqtt_auth_mode: str
    community_mqtt_username: str
    community_mqtt_password: str
    community_mqtt_iata: str
    community_mqtt_email: str
    community_mqtt_token_audience: str
    community_mqtt_websocket_path: str
    community_mqtt_profile: str
    community_mqtt_topic_template: str
    community_mqtt_token: str


def _base64url_encode(data: bytes) -> str:
    """Base64url encode without padding."""
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _generate_jwt_token(
    private_key: bytes,
    public_key: bytes,
    *,
    audience: str = _DEFAULT_BROKER,
    email: str = "",
) -> str:
    """Generate a JWT token for community MQTT authentication.

    Creates a token with Ed25519 signature using MeshCore's expanded key format.
    Token format: header_b64.payload_b64.signature_hex

    Optional ``email`` embeds a node-claiming identity so the community
    aggregator can associate this radio with an owner.
    """
    header = {"alg": "Ed25519", "typ": "JWT"}
    now = int(time.time())
    pubkey_hex = public_key.hex().upper()
    payload: dict[str, object] = {
        "publicKey": pubkey_hex,
        "iat": now,
        "exp": now + _TOKEN_LIFETIME,
        "aud": audience,
        "owner": pubkey_hex,
        "client": _get_client_version(),
    }
    if email:
        payload["email"] = email

    header_b64 = _base64url_encode(json.dumps(header, separators=(",", ":")).encode())
    payload_b64 = _base64url_encode(json.dumps(payload, separators=(",", ":")).encode())

    signing_input = f"{header_b64}.{payload_b64}".encode()

    scalar = private_key[:32]
    prefix = private_key[32:]
    signature = ed25519_sign_expanded(signing_input, scalar, prefix, public_key)

    return f"{header_b64}.{payload_b64}.{signature.hex()}"


def _decode_packet_fields(raw_bytes: bytes) -> tuple[str, str, str, list[str], int | None]:
    """Decode packet fields used by the community uploader payload format.

    Returns:
        (route_letter, packet_type_str, payload_len_str, path_values, payload_type_int)
    """
    # Reference defaults when decode fails
    route = "U"
    packet_type = "0"
    payload_len = "0"
    path_values: list[str] = []
    payload_type: int | None = None

    try:
        envelope = parse_packet_envelope(raw_bytes)
        if envelope is None or envelope.payload_version != 0:
            return route, packet_type, payload_len, path_values, payload_type

        payload_type = envelope.payload_type
        route = _ROUTE_MAP.get(envelope.route_type, "U")
        packet_type = str(payload_type)
        payload_len = str(len(envelope.payload))
        path_values = split_path_hex(envelope.path.hex(), envelope.hop_count)

        return route, packet_type, payload_len, path_values, payload_type
    except Exception:
        return route, packet_type, payload_len, path_values, payload_type


def _packet_timestamp(value: Any) -> datetime:
    """Host RX time, in UTC. Missing/invalid timestamps fall back to ingest time.

    Numeric event timestamps are Unix seconds; ISO 8601 timestamps are also
    accepted. Naive date-times are interpreted as UTC, never server local time.
    """
    try:
        if isinstance(value, bool):
            raise ValueError("boolean is not a timestamp")
        if isinstance(value, datetime):
            dt = value
        elif isinstance(value, (int, float)):
            if not math.isfinite(value):
                raise ValueError("nonfinite timestamp")
            dt = datetime.fromtimestamp(value, UTC)
        elif isinstance(value, str) and value.strip():
            dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
        else:
            raise ValueError("missing timestamp")
        return dt.replace(tzinfo=UTC) if dt.tzinfo is None else dt.astimezone(UTC)
    except (ValueError, OverflowError, OSError, TypeError):
        return datetime.now(UTC)


def _numeric_string(value: Any) -> str | None:
    """Encode only genuine finite telemetry values; missing values are omitted."""
    if value is None or isinstance(value, bool):
        return None
    try:
        numeric = float(value)
    except (TypeError, ValueError, OverflowError):
        return None
    if not math.isfinite(numeric):
        return None
    return str(int(numeric)) if numeric.is_integer() else str(numeric)


def _format_raw_packet(data: dict[str, Any], device_name: str, public_key_hex: str) -> dict | None:
    """Serialize a valid captured binary RX frame to the observer packet schema.

    Never use MQTT submission time in place of MESHRIK's host RX ingest time.
    ``score`` is omitted unless its source scale is explicitly confirmed.
    """
    raw_hex = data.get("data")
    if not isinstance(raw_hex, str):
        return None
    try:
        raw_bytes = bytes.fromhex(raw_hex)
    except ValueError:
        return None
    route, packet_type, payload_len, path_values, _ = _decode_packet_fields(raw_bytes)
    if route == "U":
        return None

    rx_time = _packet_timestamp(data.get("timestamp"))
    packet: dict[str, str | list[str]] = {
        "origin": device_name or "MeshCore Device",
        "origin_id": public_key_hex.upper(),
        "timestamp": _format_utc_timestamp(rx_time),
        "type": "PACKET",
        "direction": "rx",
        "time": rx_time.strftime("%H:%M:%S"),
        "date": rx_time.strftime("%d/%m/%Y"),
        "len": str(len(raw_bytes)),
        "packet_type": packet_type,
        "route": route,
        "payload_len": payload_len,
        "raw": raw_bytes.hex().upper(),
        "hash": calculate_packet_hash(raw_bytes),
    }
    for source, target in (("rssi", "RSSI"), ("snr", "SNR")):
        metric = _numeric_string(data.get(source))
        if metric is not None:
            packet[target] = metric

    # Transport-direct includes a path just like ordinary direct routing.
    if route in {"D", "T"} and path_values:
        packet["path"] = path_values
    return packet


def _build_status_topic(settings: CommunityMqttSettings, pubkey_hex: str) -> str:
    """Build the ``meshcore/{IATA}/{PUBKEY}/status`` topic string."""
    return community_topic(_settings_topic_config(settings), pubkey_hex, "status")


def _settings_topic_config(settings: CommunityMqttSettings) -> dict:
    return {
        "profile": getattr(settings, "community_mqtt_profile", "letsmesh"),
        "iata": getattr(settings, "community_mqtt_iata", ""),
        "token": getattr(settings, "community_mqtt_token", ""),
        "topic_template": getattr(
            settings, "community_mqtt_topic_template", "meshcore/{IATA}/{PUBLIC_KEY}/packets"
        ),
    }


def _build_radio_info() -> str:
    """Format the radio parameters string from self_info.

    Matches the reference format: ``"freq,bw,sf,cr"`` (comma-separated raw
    values).  Falls back to ``"0,0,0,0"`` when unavailable.
    """
    from app.services.radio_runtime import radio_runtime as radio_manager

    try:
        if radio_manager.meshcore and radio_manager.meshcore.self_info:
            info = radio_manager.meshcore.self_info
            freq = info.get("radio_freq", 0)
            bw = info.get("radio_bw", 0)
            sf = info.get("radio_sf", 0)
            cr = info.get("radio_cr", 0)
            return f"{freq},{bw},{sf},{cr}"
    except Exception:
        pass
    return "0,0,0,0"


def _get_client_version() -> str:
    """Return the canonical client/version identifier for community MQTT."""
    build = get_app_build_info()
    commit_hash = build.commit_hash or "unknown"
    return f"{_CLIENT_ID}/{build.version}-{commit_hash}"


_BROKER_ERROR_REMEDIES = {
    "PUBLISH_PLACEHOLDER_IATA": "Choose your actual ingress airport code in broker settings.",
    "PUBLISH_UNKNOWN_IATA": "Choose an IATA code supported by this broker.",
    "PUBLISH_STALE_STATUS": "Check the server clock and reconnect to refresh online status.",
    "PUBLISH_STALE_CONNECTION": "Reconnect the integration and check for duplicate clients.",
    "PUBLISH_ORIGIN_MISMATCH": "Check that the connected radio matches the authenticated identity.",
    "PUBLISH_PAYLOAD_TOO_LARGE": "Reduce the neighbor snapshot or packet size.",
    "PUBLISH_RESERVED_SUBTOPIC": "Choose a supported status, packets or neighbors topic.",
}
_ERROR_CODE_PATTERN = re.compile(r"^[A-Z][A-Z0-9_]{0,63}$")
_MAX_BROKER_ERROR_BYTES = 4096


def parse_broker_error(payload: bytes) -> tuple[str, str, str] | None:
    """Only expose broker error code and safe local explanation, not untrusted text."""
    if len(payload) > _MAX_BROKER_ERROR_BYTES:
        return None
    try:
        event = json.loads(payload)
        if not isinstance(event, dict):
            return None
        code = event.get("code")
        if not isinstance(code, str) or not _ERROR_CODE_PATTERN.fullmatch(code):
            return None
        at = event.get("at")
        timestamp = _format_utc_timestamp(_packet_timestamp(at)) if at else _format_utc_timestamp()
        return (
            code,
            _BROKER_ERROR_REMEDIES.get(
                code, "Broker refused a publish; verify integration settings."
            ),
            timestamp,
        )
    except (ValueError, TypeError):
        return None


class CommunityMqttPublisher(BaseMqttPublisher):
    """Manages the community MQTT connection and publishes raw packets."""

    _backoff_max = 3600
    _log_prefix = "Community MQTT"
    _not_configured_timeout: float | None = 30

    def __init__(self) -> None:
        super().__init__()
        self._key_unavailable_warned: bool = False
        self._cached_device_info: dict[str, str] | None = None
        self._cached_stats: dict[str, Any] | None = None
        self._stats_supported: bool | None = None
        self._last_stats_fetch: float = 0.0
        self._last_status_publish: float = 0.0
        self._error_reader: asyncio.Task[None] | None = None
        self.broker_error_code: str | None = None
        self.broker_error_at: str | None = None

    async def start(self, settings: object) -> None:
        self._key_unavailable_warned = False
        self._cached_device_info = None
        self._cached_stats = None
        self._stats_supported = None
        self._last_stats_fetch = 0.0
        self._last_status_publish = 0.0
        await super().start(settings)

    @property
    def last_error(self) -> str | None:
        if self.broker_error_code:
            return f"{self.broker_error_code}: {_BROKER_ERROR_REMEDIES.get(self.broker_error_code, 'Broker rejected a publish; check settings.')}"
        return super().last_error

    async def _read_broker_errors(self, allowed: tuple[str, ...]) -> None:
        client = self._client
        if client is None:
            return
        try:
            async for message in client.messages:
                if str(message.topic) not in allowed:
                    continue
                incoming = message.payload
                if not isinstance(incoming, bytes):
                    continue
                result = parse_broker_error(incoming)
                if result is None:
                    continue
                self.broker_error_code, _remedy, self.broker_error_at = result
                from app.fanout.mqtt_base import _broadcast_health

                _broadcast_health()
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.debug("Community MQTT diagnostic subscription ended")

    async def _on_disconnected_async(self) -> None:
        if self._error_reader is not None:
            self._error_reader.cancel()
            try:
                await self._error_reader
            except asyncio.CancelledError:
                pass
            self._error_reader = None

    def _on_not_configured(self) -> None:
        from app.keystore import get_public_key, has_private_key
        from app.websocket import broadcast_error

        s: CommunityMqttSettings | None = self._settings
        auth_mode = getattr(s, "community_mqtt_auth_mode", "token") if s else "token"
        if (
            s
            and auth_mode == "token"
            and get_public_key() is not None
            and not has_private_key()
            and not self._key_unavailable_warned
        ):
            broadcast_error(
                "Community MQTT unavailable",
                "Radio firmware does not support private key export.",
            )
            self._key_unavailable_warned = True

    def _is_configured(self) -> bool:
        """Check if community MQTT is enabled and keys are available."""
        from app.keystore import get_public_key, has_private_key

        s: CommunityMqttSettings | None = self._settings
        if not s or not s.community_mqtt_enabled:
            return False
        if get_public_key() is None:
            return False
        auth_mode = getattr(s, "community_mqtt_auth_mode", "token")
        if auth_mode == "token":
            return has_private_key()
        try:
            validate_profile(_settings_topic_config(s))
        except ValueError as exc:
            self._last_error = str(exc)
            return False
        return True

    def _build_client_kwargs(self, settings: object) -> dict[str, Any]:
        s: CommunityMqttSettings = settings  # type: ignore[assignment]
        from app.keystore import get_private_key, get_public_key
        from app.services.radio_runtime import radio_runtime as radio_manager

        private_key = get_private_key()
        public_key = get_public_key()
        assert public_key is not None  # guaranteed by _pre_connect

        pubkey_hex = public_key.hex().upper()
        broker_host = s.community_mqtt_broker_host or _DEFAULT_BROKER
        broker_port = s.community_mqtt_broker_port or _DEFAULT_PORT
        transport = s.community_mqtt_transport or "websockets"
        use_tls = bool(s.community_mqtt_use_tls)
        tls_verify = bool(s.community_mqtt_tls_verify)
        auth_mode = s.community_mqtt_auth_mode or "token"
        secure_connection = use_tls and tls_verify

        tls_context: ssl.SSLContext | None = None
        if use_tls:
            tls_context = ssl.create_default_context()
            if not tls_verify:
                tls_context.check_hostname = False
                tls_context.verify_mode = ssl.CERT_NONE

        device_name = ""
        if radio_manager.meshcore and radio_manager.meshcore.self_info:
            device_name = radio_manager.meshcore.self_info.get("name", "")

        status_topic = _build_status_topic(s, pubkey_hex)
        offline_payload = json.dumps(
            {
                "status": "offline",
                "timestamp": _format_utc_timestamp(),
                "origin": device_name or "MeshCore Device",
                "origin_id": pubkey_hex,
            }
        )

        kwargs: dict[str, Any] = {
            "hostname": broker_host,
            "port": broker_port,
            "transport": transport,
            "tls_context": tls_context,
            "will": aiomqtt.Will(
                status_topic,
                offline_payload,
                retain=broker_retains(_settings_topic_config(s), "status"),
            ),
        }
        if auth_mode == "token":
            assert private_key is not None
            token_audience = (s.community_mqtt_token_audience or "").strip() or broker_host
            jwt_token = _generate_jwt_token(
                private_key,
                public_key,
                audience=token_audience,
                email=(s.community_mqtt_email or "") if secure_connection else "",
            )
            kwargs["username"] = f"v1_{pubkey_hex}"
            kwargs["password"] = jwt_token
        elif auth_mode == "password":
            kwargs["username"] = s.community_mqtt_username or None
            kwargs["password"] = s.community_mqtt_password or None
        if transport == "websockets":
            kwargs["websocket_path"] = (s.community_mqtt_websocket_path or "").strip() or "/"
        return kwargs

    def _on_connected(self, settings: object) -> tuple[str, str]:
        s: CommunityMqttSettings = settings  # type: ignore[assignment]
        broker_host = s.community_mqtt_broker_host or _DEFAULT_BROKER
        broker_port = s.community_mqtt_broker_port or _DEFAULT_PORT
        return ("Community MQTT connected", f"{broker_host}:{broker_port}")

    async def _fetch_device_info(self) -> dict[str, str]:
        """Fetch firmware model/version from the radio (cached for the connection)."""
        if self._cached_device_info is not None:
            return self._cached_device_info

        from app.radio import RadioDisconnectedError, RadioOperationBusyError
        from app.services.radio_runtime import radio_runtime as radio_manager

        fallback = {"model": "unknown", "firmware_version": "unknown"}

        async def fetch_device_info(mc):
            return await mc.commands.send_device_query()

        try:
            event = await radio_manager.run_radio_command(
                "community_stats_device_info", fetch_device_info, blocking=False
            )
            from meshcore.events import EventType

            if event.type == EventType.DEVICE_INFO:
                fw_ver = event.payload.get("fw ver", 0)
                if fw_ver >= 3:
                    model = event.payload.get("model", "unknown") or "unknown"
                    ver = event.payload.get("ver", "unknown") or "unknown"
                    fw_build = event.payload.get("fw_build", "") or ""
                    fw_str = f"v{ver} (Build: {fw_build})" if fw_build else f"v{ver}"
                    self._cached_device_info = {
                        "model": model,
                        "firmware_version": fw_str,
                    }
                else:
                    # Old firmware — cache what we can
                    self._cached_device_info = {
                        "model": "unknown",
                        "firmware_version": f"v{fw_ver}" if fw_ver else "unknown",
                    }
                return self._cached_device_info
        except (RadioOperationBusyError, RadioDisconnectedError):
            pass
        except Exception as e:
            logger.debug("Community MQTT: device info fetch failed: %s", e)

        # Don't cache transient failures — allow retry on next status publish
        return fallback

    async def _fetch_stats(self) -> dict[str, Any] | None:
        """Fetch core + radio stats from the radio (best-effort, cached)."""
        if self._stats_supported is False:
            return self._cached_stats

        now = time.monotonic()
        if (
            now - self._last_stats_fetch
        ) < _STATS_MIN_CACHE_SECS and self._cached_stats is not None:
            return self._cached_stats

        from app.radio import RadioDisconnectedError, RadioOperationBusyError
        from app.services.radio_runtime import radio_runtime as radio_manager

        async def fetch_stats(mc):
            from meshcore.events import EventType

            result: dict[str, Any] = {}
            core_event = await mc.commands.get_stats_core()
            if core_event.type == EventType.ERROR:
                return None
            if core_event.type == EventType.STATS_CORE:
                result.update(core_event.payload)

            radio_event = await mc.commands.get_stats_radio()
            if radio_event.type == EventType.ERROR:
                return None
            if radio_event.type == EventType.STATS_RADIO:
                result.update(radio_event.payload)
            return result

        try:
            result = await radio_manager.run_radio_command(
                "community_stats_fetch", fetch_stats, blocking=False
            )
            if result is None:
                logger.info("Community MQTT: firmware does not support stats commands")
                self._stats_supported = False
                return self._cached_stats
            if result:
                self._cached_stats = result
                self._last_stats_fetch = now
                return self._cached_stats

        except (RadioOperationBusyError, RadioDisconnectedError):
            pass
        except Exception as e:
            logger.debug("Community MQTT: stats fetch failed: %s", e)

        return self._cached_stats

    async def _publish_status(
        self, settings: CommunityMqttSettings, *, refresh_stats: bool = True
    ) -> None:
        """Build and publish the enriched retained status message."""
        from app.keystore import get_public_key
        from app.services.radio_runtime import radio_runtime as radio_manager

        public_key = get_public_key()
        if public_key is None:
            return

        pubkey_hex = public_key.hex().upper()

        device_name = ""
        if radio_manager.meshcore and radio_manager.meshcore.self_info:
            device_name = radio_manager.meshcore.self_info.get("name", "")

        # Prefer the always-fresh radio_manager fields (populated on every reconnect by
        # radio_lifecycle) over the per-module _cached_device_info, which was only
        # cleared on module restart and therefore served stale firmware versions after
        # a radio firmware update.  Fall back to _fetch_device_info() for older firmware
        # where device_info_loaded is False.
        if radio_manager.device_info_loaded:
            raw_ver = radio_manager.firmware_version or "unknown"
            fw_build = radio_manager.firmware_build or ""
            fw_str = f"{raw_ver} (Build: {fw_build})" if fw_build else f"{raw_ver}"
            device_info = {
                "model": radio_manager.device_model or "unknown",
                "firmware_version": fw_str,
            }
        else:
            device_info = await self._fetch_device_info()
        stats = await self._fetch_stats() if refresh_stats else self._cached_stats

        status_topic = _build_status_topic(settings, pubkey_hex)
        payload: dict[str, Any] = {
            "status": "online",
            "timestamp": _format_utc_timestamp(),
            "origin": device_name or "MeshCore Device",
            "origin_id": pubkey_hex,
            "model": device_info.get("model", "unknown"),
            "firmware_version": device_info.get("firmware_version", "unknown"),
            "radio": _build_radio_info(),
            "client_version": _get_client_version(),
        }
        if stats:
            payload["stats"] = stats

        await self.publish(
            status_topic, payload, retain=broker_retains(_settings_topic_config(settings), "status")
        )
        self._last_status_publish = time.monotonic()

    async def submit_packet(self, topic: str, packet: dict[str, Any]) -> bool:
        """True means QoS0 *local submission*, never broker acceptance."""
        client = self._client
        if not self.connected or client is None:
            return False
        try:
            await client.publish(topic, json.dumps(packet), retain=False)
            return True
        except Exception:
            self.connected = False
            self._last_error = "MQTT packet submission failed; awaiting reconnect"
            self._settings_version += 1
            self._version_event.set()
            return False

    async def _publish_neighbors(self, settings: CommunityMqttSettings) -> bool:
        """Publish only previously observed host-sampled data, without transmitting RF."""
        if not getattr(settings, "community_mqtt_publish_neighbors", False):
            return False
        from app.keystore import get_public_key
        from app.repository.observed_neighbors import (
            build_observed_neighbors_payload,
            get_recent_observations,
        )
        from app.services.radio_runtime import radio_runtime as radio_manager

        key = get_public_key()
        if key is None or not self.connected:
            return False
        name = (
            (radio_manager.meshcore.self_info or {}).get("name", "")
            if radio_manager.meshcore
            else ""
        )
        payload = build_observed_neighbors_payload(
            await get_recent_observations(),
            name,
            key.hex(),
        )
        await self.publish(
            community_topic(_settings_topic_config(settings), key.hex(), "neighbors"),
            payload,
            retain=broker_retains(_settings_topic_config(settings), "neighbors"),
        )
        return True

    async def _on_connected_async(self, settings: object) -> None:
        """Subscribe to own diagnostics before submitting the first packet."""
        from app.keystore import get_public_key

        public_key = get_public_key()
        if public_key is not None and self._client is not None:
            allowed = error_subscriptions(
                _settings_topic_config(settings),  # type: ignore[arg-type]
                public_key.hex().upper(),
            )
            for topic in allowed:
                await self._client.subscribe(topic, qos=0)
            if allowed:
                self._error_reader = asyncio.create_task(self._read_broker_errors(allowed))
        await self._publish_status(settings)  # type: ignore[arg-type]

    async def _on_periodic_wake(self, elapsed: float) -> None:
        if not self._settings:
            return
        now = time.monotonic()
        if (now - self._last_status_publish) >= _STATS_REFRESH_INTERVAL:
            await self._publish_status(self._settings, refresh_stats=True)

    def _on_error(self) -> tuple[str, str]:
        return (
            "Community MQTT connection failure",
            "Check your internet connection or try again later.",
        )

    def _should_break_wait(self, elapsed: float) -> bool:
        if not self.connected:
            logger.info("Community MQTT publish failure detected, reconnecting")
            return True
        s: CommunityMqttSettings | None = self._settings
        auth_mode = getattr(s, "community_mqtt_auth_mode", "token") if s else "token"
        if auth_mode == "token" and elapsed >= _TOKEN_RENEWAL_THRESHOLD:
            logger.info("Community MQTT JWT nearing expiry, reconnecting")
            return True
        return False

    async def _pre_connect(self, settings: object) -> bool:
        from app.keystore import get_private_key, get_public_key

        s: CommunityMqttSettings = settings  # type: ignore[assignment]
        auth_mode = s.community_mqtt_auth_mode or "token"
        private_key = get_private_key()
        public_key = get_public_key()
        if public_key is None or (auth_mode == "token" and private_key is None):
            # Keys not available yet, wait for settings change or key export
            self.connected = False
            self._version_event.clear()
            try:
                await asyncio.wait_for(self._version_event.wait(), timeout=30)
            except TimeoutError:
                pass
            return False
        return True
