"""Read-only virtual Companion identity snapshot and handshake encoding."""

import struct
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from .dispatch import CommandDispatcher, DispatchContext

CMD_APP_START = 0x01
CMD_DEVICE_QUERY = 0x16
RESP_CODE_ERR = 0x01
RESP_CODE_SELF_INFO = 0x05
RESP_CODE_DEVICE_INFO = 0x0D
ERR_CODE_BAD_STATE = 0x04
ERR_CODE_ILLEGAL_ARG = 0x06
MIN_SUPPORTED_PROTOCOL = 13
MAX_VIRTUAL_PROTOCOL = 14


@dataclass(frozen=True, slots=True)
class CompanionIdentitySnapshot:
    generation: int
    protocol_version: int
    public_key: bytes
    name: str
    advert_type: int
    tx_power: int
    max_tx_power: int
    latitude: float
    longitude: float
    multi_acks: int
    advert_location_policy: int
    telemetry_mode_base: int
    telemetry_mode_location: int
    telemetry_mode_environment: int
    manual_add_contacts: bool
    frequency_mhz: float
    bandwidth_khz: float
    spreading_factor: int
    coding_rate: int
    max_contacts: int
    max_channels: int
    firmware_build: str
    device_model: str
    firmware_version: str
    repeat_enabled: bool
    path_hash_mode: int


class IdentityUnavailable(RuntimeError):
    """The current radio generation has no complete verified identity."""


IdentityProvider = Callable[[], CompanionIdentitySnapshot]


def get_runtime_generation() -> int:
    from app.services.radio_runtime import radio_runtime

    return int(radio_runtime.radio_generation)


def get_identity_snapshot(runtime: Any | None = None) -> CompanionIdentitySnapshot:
    """Copy already-loaded runtime state without issuing a physical command."""
    if runtime is None:
        from app.services.radio_runtime import radio_runtime

        runtime = radio_runtime

    generation = int(getattr(runtime, "radio_generation", -1))
    if generation < 0 or not bool(getattr(runtime, "is_connected", False)):
        raise IdentityUnavailable("radio identity is not currently verified")
    if not bool(getattr(runtime, "device_info_loaded", False)):
        raise IdentityUnavailable("radio device metadata is not loaded")
    mc = getattr(runtime, "meshcore", None)
    info = getattr(mc, "self_info", None) if mc is not None else None
    if not isinstance(info, dict):
        raise IdentityUnavailable("radio self info is not loaded")

    public_key_hex = info.get("public_key")
    if not isinstance(public_key_hex, str):
        raise IdentityUnavailable("radio public identity is missing")
    try:
        public_key = bytes.fromhex(public_key_hex)
    except ValueError as exc:
        raise IdentityUnavailable("radio public identity is invalid") from exc
    if len(public_key) != 32:
        raise IdentityUnavailable("radio public identity must be 32 bytes")

    physical_protocol = _required_int(runtime, "firmware_ver_code", 1, 255)
    protocol_version = min(physical_protocol, MAX_VIRTUAL_PROTOCOL)
    if protocol_version < MIN_SUPPORTED_PROTOCOL:
        raise IdentityUnavailable("radio protocol is older than the virtual contract")

    max_contacts = _required_int(runtime, "max_contacts", 1, 510)
    max_channels = _required_int(runtime, "max_channels", 1, 255)
    return CompanionIdentitySnapshot(
        generation=generation,
        protocol_version=protocol_version,
        public_key=public_key,
        name=_required_str(info, "name"),
        advert_type=_required_int(info, "adv_type", 0, 255),
        tx_power=_required_int(info, "tx_power", -128, 127),
        max_tx_power=_required_int(info, "max_tx_power", -128, 127),
        latitude=_required_float(info, "adv_lat", -90, 90),
        longitude=_required_float(info, "adv_lon", -180, 180),
        multi_acks=_optional_flag(info, "multi_acks"),
        advert_location_policy=_optional_byte(info, "adv_loc_policy"),
        telemetry_mode_base=_optional_mode(info, "telemetry_mode_base"),
        telemetry_mode_location=_optional_mode(info, "telemetry_mode_loc"),
        telemetry_mode_environment=_optional_mode(info, "telemetry_mode_env"),
        manual_add_contacts=bool(info.get("manual_add_contacts", False)),
        frequency_mhz=_required_float(info, "radio_freq", 1, 10000),
        bandwidth_khz=_required_float(info, "radio_bw", 1, 10000),
        spreading_factor=_required_int(info, "radio_sf", 1, 255),
        coding_rate=_required_int(info, "radio_cr", 1, 255),
        max_contacts=max_contacts,
        max_channels=max_channels,
        firmware_build=_optional_str(runtime, "firmware_build"),
        device_model=_optional_str(runtime, "device_model"),
        firmware_version=_optional_str(runtime, "firmware_version"),
        repeat_enabled=bool(getattr(runtime, "repeat_enabled", False)),
        path_hash_mode=(
            _required_int(runtime, "path_hash_mode", 0, 2)
            if bool(getattr(runtime, "path_hash_mode_supported", False))
            else 0
        ),
    )


def build_identity_dispatcher(
    identity_provider: IdentityProvider = get_identity_snapshot,
) -> CommandDispatcher:
    dispatcher = CommandDispatcher()

    async def device_query(payload: bytes, context: DispatchContext) -> bytes:
        requested = payload[1]
        if requested < MIN_SUPPORTED_PROTOCOL:
            return bytes((RESP_CODE_ERR, ERR_CODE_ILLEGAL_ARG))
        try:
            snapshot = _bind_snapshot(context, identity_provider())
        except IdentityUnavailable:
            return bytes((RESP_CODE_ERR, ERR_CODE_BAD_STATE))
        context.protocol_version = min(requested, snapshot.protocol_version)
        return encode_device_info(snapshot)

    async def app_start(_payload: bytes, context: DispatchContext) -> bytes:
        try:
            snapshot = _bind_snapshot(context, identity_provider())
        except IdentityUnavailable:
            return bytes((RESP_CODE_ERR, ERR_CODE_BAD_STATE))
        return encode_self_info(snapshot)

    dispatcher.register(CMD_DEVICE_QUERY, device_query, min_length=2, max_length=2)
    dispatcher.register(CMD_APP_START, app_start, min_length=8, max_length=176)
    return dispatcher


def _bind_snapshot(
    context: DispatchContext, snapshot: CompanionIdentitySnapshot
) -> CompanionIdentitySnapshot:
    if context.identity_generation is None:
        context.identity_generation = snapshot.generation
    elif context.identity_generation != snapshot.generation:
        raise IdentityUnavailable("radio generation changed")
    return snapshot


def encode_self_info(snapshot: CompanionIdentitySnapshot) -> bytes:
    telemetry = (
        (snapshot.telemetry_mode_environment << 4)
        | (snapshot.telemetry_mode_location << 2)
        | snapshot.telemetry_mode_base
    )
    fixed = bytearray(
        (
            RESP_CODE_SELF_INFO,
            snapshot.advert_type,
            snapshot.tx_power & 0xFF,
            snapshot.max_tx_power & 0xFF,
        )
    )
    fixed.extend(snapshot.public_key)
    fixed.extend(
        struct.pack(
            "<iiBBBBIIBB",
            round(snapshot.latitude * 1_000_000),
            round(snapshot.longitude * 1_000_000),
            snapshot.multi_acks,
            snapshot.advert_location_policy,
            telemetry,
            int(snapshot.manual_add_contacts),
            round(snapshot.frequency_mhz * 1000),
            round(snapshot.bandwidth_khz * 1000),
            snapshot.spreading_factor,
            snapshot.coding_rate,
        )
    )
    fixed.extend(_utf8_prefix(snapshot.name, 176 - len(fixed)))
    return bytes(fixed)


def encode_device_info(snapshot: CompanionIdentitySnapshot) -> bytes:
    result = bytearray(
        (
            RESP_CODE_DEVICE_INFO,
            snapshot.protocol_version,
            min(255, snapshot.max_contacts // 2),
            snapshot.max_channels,
        )
    )
    result.extend(bytes(4))  # Never expose the physical BLE PIN.
    result.extend(_fixed_utf8(snapshot.firmware_build, 12))
    result.extend(_fixed_utf8(snapshot.device_model, 40))
    result.extend(_fixed_utf8(snapshot.firmware_version, 20))
    result.extend((int(snapshot.repeat_enabled), snapshot.path_hash_mode))
    return bytes(result)


def _fixed_utf8(value: str, width: int) -> bytes:
    encoded = _utf8_prefix(value, max(0, width - 1))
    return encoded.ljust(width, b"\0")


def _utf8_prefix(value: str, width: int) -> bytes:
    encoded = value.encode("utf-8")[:width]
    while encoded:
        try:
            encoded.decode("utf-8")
            return encoded
        except UnicodeDecodeError:
            encoded = encoded[:-1]
    return b""


def _required_int(source: Any, key: str, low: int, high: int) -> int:
    value = source.get(key) if isinstance(source, dict) else getattr(source, key, None)
    if type(value) is not int or not low <= value <= high:
        raise IdentityUnavailable(f"radio {key} is unavailable")
    return value


def _required_float(source: dict, key: str, low: float, high: float) -> float:
    value = source.get(key)
    if not isinstance(value, int | float) or isinstance(value, bool) or not low <= value <= high:
        raise IdentityUnavailable(f"radio {key} is unavailable")
    return float(value)


def _required_str(source: dict, key: str) -> str:
    value = source.get(key)
    if not isinstance(value, str) or not value.strip():
        raise IdentityUnavailable(f"radio {key} is unavailable")
    return value


def _optional_str(source: Any, key: str) -> str:
    value = getattr(source, key, None)
    return value if isinstance(value, str) else ""


def _optional_byte(source: dict, key: str) -> int:
    value = source.get(key, 0)
    return value if type(value) is int and 0 <= value <= 255 else 0


def _optional_flag(source: dict, key: str) -> int:
    return int(bool(source.get(key, 0)))


def _optional_mode(source: dict, key: str) -> int:
    value = source.get(key, 0)
    return value if type(value) is int and 0 <= value <= 2 else 0
