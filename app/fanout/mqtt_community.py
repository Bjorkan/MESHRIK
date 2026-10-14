"""Fanout module wrapping the community MQTT publisher."""

from __future__ import annotations

import asyncio
import json
import logging
import re
import string
from collections import deque
from types import SimpleNamespace
from typing import Any

from app.fanout.base import FanoutModule
from app.fanout.community_mqtt import CommunityMqttPublisher, _format_raw_packet
from app.fanout.community_topics import community_topic, resolve_profile

logger = logging.getLogger(__name__)

_IATA_RE = re.compile(r"^[A-Z]{3}$")
_DEFAULT_PACKET_TOPIC_TEMPLATE = "meshcore/{IATA}/{PUBLIC_KEY}/packets"
_TOPIC_TEMPLATE_FIELD_CANONICAL = {
    "iata": "IATA",
    "public_key": "PUBLIC_KEY",
}


def _normalize_topic_template(topic_template: str) -> str:
    """Normalize packet topic template fields to canonical uppercase placeholders."""
    template = topic_template.strip() or _DEFAULT_PACKET_TOPIC_TEMPLATE
    parts: list[str] = []
    try:
        parsed = string.Formatter().parse(template)
        for literal_text, field_name, format_spec, conversion in parsed:
            parts.append(literal_text)
            if field_name is None:
                continue
            normalized_field = _TOPIC_TEMPLATE_FIELD_CANONICAL.get(field_name.lower())
            if normalized_field is None:
                raise ValueError(f"Unsupported topic template field(s): {field_name}")
            replacement = ["{", normalized_field]
            if conversion:
                replacement.extend(["!", conversion])
            if format_spec:
                replacement.extend([":", format_spec])
            replacement.append("}")
            parts.append("".join(replacement))
    except ValueError:
        raise

    return "".join(parts)


def _config_to_settings(config: dict) -> SimpleNamespace:
    """Map a fanout config blob to a settings namespace for the CommunityMqttPublisher."""
    return SimpleNamespace(
        community_mqtt_enabled=True,
        community_mqtt_profile=resolve_profile(config),
        community_mqtt_topic_template=config.get("topic_template", _DEFAULT_PACKET_TOPIC_TEMPLATE),
        community_mqtt_token=config.get("token", ""),
        community_mqtt_publish_status=config.get("publish_status", True),
        community_mqtt_publish_packets=config.get("publish_packets", True),
        community_mqtt_publish_neighbors=config.get("publish_neighbors", False),
        community_mqtt_status_interval_minutes=config.get("status_interval_minutes", 5),
        community_mqtt_neighbors_interval_hours=config.get("neighbors_interval_hours", 24),
        community_mqtt_broker_host=config.get("broker_host", "mqtt-us-v1.letsmesh.net"),
        community_mqtt_broker_port=config.get("broker_port", 443),
        community_mqtt_transport=config.get("transport", "websockets"),
        community_mqtt_use_tls=config.get("use_tls", True),
        community_mqtt_tls_verify=config.get("tls_verify", True),
        community_mqtt_auth_mode=config.get("auth_mode", "token"),
        community_mqtt_username=config.get("username", ""),
        community_mqtt_password=config.get("password", ""),
        community_mqtt_iata=config.get("iata", ""),
        community_mqtt_email=config.get("email", ""),
        community_mqtt_token_audience=config.get("token_audience", ""),
        community_mqtt_websocket_path=config.get("websocket_path", "/"),
    )


def _render_packet_topic(topic_template: str, *, iata: str, public_key: str) -> str:
    """Render the configured raw-packet publish topic."""
    template = _normalize_topic_template(topic_template)
    return community_topic(
        {"profile": "custom", "iata": iata, "topic_template": template}, public_key, "packets"
    )


class MqttCommunityModule(FanoutModule):
    """Wraps a CommunityMqttPublisher for community packet sharing."""

    def __init__(self, config_id: str, config: dict, *, name: str = "") -> None:
        self._packet_queue: deque[tuple[str, dict, int]] = deque()
        self._queue_bytes = 0
        self._queue_limit_entries = 512
        self._queue_limit_bytes = 4 * 1024 * 1024
        self.dropped_packets = 0
        self.submitted_packets = 0
        self._flush_task: asyncio.Task[None] | None = None
        super().__init__(config_id, config, name=name)
        self._publisher = CommunityMqttPublisher()
        self._publisher.set_integration_name(name or config_id)

    async def start(self) -> None:
        settings = _config_to_settings(self.config)
        await self._publisher.start(settings)
        if self._flush_task is None or self._flush_task.done():
            self._flush_task = asyncio.create_task(self._flush_packets())

    async def stop(self) -> None:
        if self._flush_task is not None:
            self._flush_task.cancel()
            try:
                await self._flush_task
            except asyncio.CancelledError:
                pass
            self._flush_task = None
        self._packet_queue.clear()
        self._queue_bytes = 0
        await self._publisher.stop()

    @property
    def queue_stats(self) -> dict[str, int]:
        return {
            "queued": len(self._packet_queue),
            "queued_bytes": self._queue_bytes,
            "dropped": self.dropped_packets,
            "submitted_to_client": self.submitted_packets,
        }

    def _enqueue(self, topic: str, packet: dict) -> None:
        size = len(topic.encode()) + len(json.dumps(packet, separators=(",", ":")).encode())
        if size > self._queue_limit_bytes:
            self.dropped_packets += 1
            return
        while self._packet_queue and (
            len(self._packet_queue) >= self._queue_limit_entries
            or self._queue_bytes + size > self._queue_limit_bytes
        ):
            _old_topic, _old_packet, old_bytes = self._packet_queue.popleft()
            self._queue_bytes -= old_bytes
            self.dropped_packets += 1
        self._packet_queue.append((topic, packet, size))
        self._queue_bytes += size

    async def _flush_packets(self) -> None:
        """Bounded batches prevent slow brokers blocking radio event dispatch."""
        while True:
            try:
                for _ in range(16):
                    if not self._packet_queue or not self._publisher.connected:
                        break
                    topic, packet, size = self._packet_queue[0]
                    ok = await self._publisher.submit_packet(topic, packet)
                    if not ok:
                        break  # Keep unsubmitted head and retry after reconnect.
                    self._packet_queue.popleft()
                    self._queue_bytes -= size
                    self.submitted_packets += 1
                await asyncio.sleep(
                    0.25 if self._packet_queue and self._publisher.connected else 1.0
                )
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.warning("Community MQTT packet queue worker failed (details suppressed)")
                await asyncio.sleep(1.0)

    async def on_message(self, data: dict) -> None:
        # Community MQTT only publishes raw packets, not decoded messages.
        pass

    async def on_raw(self, data: dict) -> None:
        prepared = _prepare_community_packet(self.config, data)
        if prepared is not None:
            self._enqueue(*prepared)

    @property
    def status(self) -> str:
        if self.last_error:
            return "error"
        if self._publisher._is_configured():
            return "connected" if self._publisher.connected else "disconnected"
        return "disconnected"

    @property
    def last_error(self) -> str | None:
        if self._publisher.last_error:
            return self._publisher.last_error
        return self._key_unavailable_reason()

    def _key_unavailable_reason(self) -> str | None:
        """Explain a silent "disconnected" caused by a missing radio key.

        Community MQTT can only authenticate (and derive its topic/identity)
        with the radio's own key, which is exported from the radio on connect.
        When the radio is fully connected and set up but the keystore is still
        empty, the key export was refused or never answered -- typically
        firmware without ENABLE_PRIVATE_KEY_EXPORT, or a proxy transport
        (e.g. Meshmonitor) that does not forward the key-export command.

        Surfacing this as the module's ``last_error`` promotes the fanout status
        to "error" and lights up the existing per-card error detail, instead of
        leaving the operator staring at a bare "Disconnected". See issue #321.

        Gated on ``is_setup_complete`` so we do not falsely accuse the radio
        during the normal connect/key-export window.
        """
        from app.keystore import get_public_key
        from app.services.radio_runtime import radio_runtime as radio_manager

        if get_public_key() is not None:
            return None
        if not (radio_manager.is_connected and radio_manager.is_setup_complete):
            return None
        return (
            "Community MQTT needs the radio's private key to authenticate, but it "
            "isn't available. Your radio firmware may not support key export "
            "(ENABLE_PRIVATE_KEY_EXPORT=1), or you're connecting through a proxy "
            "that doesn't forward the key-export command."
        )


def _prepare_community_packet(
    config: dict,
    data: dict[str, Any],
) -> tuple[str, dict] | None:
    """Format once at RX ingest, preserving timestamp across broker outages."""
    try:
        from app.keystore import get_public_key
        from app.services.radio_runtime import radio_runtime as radio_manager

        public_key = get_public_key()
        if public_key is None:
            return None
        pubkey_hex = public_key.hex().upper()
        device_name = ""
        if radio_manager.meshcore and radio_manager.meshcore.self_info:
            device_name = radio_manager.meshcore.self_info.get("name", "")
        packet = _format_raw_packet(data, device_name, pubkey_hex)
        if packet is None:
            return None
        topic = community_topic(config, pubkey_hex, "packets")
        return topic, packet
    except (ValueError, TypeError):
        logger.debug("Community MQTT packet skipped: invalid configuration or packet")
        return None


async def _publish_community_packet(
    publisher: CommunityMqttPublisher,
    config: dict,
    data: dict[str, Any],
) -> None:
    """Compatibility helper for one-off publishing; module traffic uses FIFO."""
    prepared = _prepare_community_packet(config, data)
    if prepared is not None:
        await publisher.submit_packet(*prepared)
