"""REST API for fanout config CRUD."""

import ast
import inspect
import ipaddress
import logging
import re
import sqlite3
import string

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app.fanout.bot_exec import _analyze_bot_signature
from app.fanout.manager import fanout_manager
from app.repository.fanout import FanoutConfigRepository

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/fanout", tags=["fanout"])

_VALID_TYPES = {
    "mqtt_private",
    "mqtt_community",
    "mqtt_ha",
    "bot",
    "webhook",
    "apprise",
    "sqs",
    "map_upload",
    "virtual_companion_tcp",
}

_VIRTUAL_COMPANION_DEFAULT_HOST = "0.0.0.0"
_VIRTUAL_COMPANION_DEFAULT_PORT = 5000
_VIRTUAL_COMPANION_CONFIG_FIELDS = {
    "bind_host",
    "channel_slots",
    "port",
    "unsafe_network_acknowledged",
    "secure_access",
    "virtual_channel_capacity",
}
_VIRTUAL_COMPANION_SECURE_ACCESS = {"vpn", "mtls_proxy"}

_IATA_RE = re.compile(r"^[A-Z]{3}$")
_DEFAULT_COMMUNITY_MQTT_TOPIC_TEMPLATE = "meshcore/{IATA}/{PUBLIC_KEY}/packets"
_DEFAULT_COMMUNITY_MQTT_BROKER_HOST = "mqtt-us-v1.letsmesh.net"
_DEFAULT_COMMUNITY_MQTT_BROKER_PORT = 443
_DEFAULT_COMMUNITY_MQTT_TRANSPORT = "websockets"
_DEFAULT_COMMUNITY_MQTT_AUTH_MODE = "token"
_COMMUNITY_MQTT_TEMPLATE_FIELD_CANONICAL = {
    "iata": "IATA",
    "public_key": "PUBLIC_KEY",
}
_ALLOWED_COMMUNITY_MQTT_TRANSPORTS = {"tcp", "websockets"}
_ALLOWED_COMMUNITY_MQTT_AUTH_MODES = {"token", "password", "none"}


def _normalize_community_topic_template(topic_template: str) -> str:
    """Normalize Community MQTT topic template placeholders to canonical uppercase form."""
    template = topic_template.strip() or _DEFAULT_COMMUNITY_MQTT_TOPIC_TEMPLATE
    parts: list[str] = []
    try:
        parsed = string.Formatter().parse(template)
        for literal_text, field_name, format_spec, conversion in parsed:
            parts.append(literal_text)
            if field_name is None:
                continue
            normalized_field = _COMMUNITY_MQTT_TEMPLATE_FIELD_CANONICAL.get(field_name.lower())
            if normalized_field is None:
                raise HTTPException(
                    status_code=400,
                    detail=(
                        f"topic_template may only use {{IATA}} and {{PUBLIC_KEY}}; got {field_name}"
                    ),
                )
            replacement = ["{", normalized_field]
            if conversion:
                replacement.extend(["!", conversion])
            if format_spec:
                replacement.extend([":", format_spec])
            replacement.append("}")
            parts.append("".join(replacement))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=f"Invalid topic_template: {exc}") from None

    return "".join(parts)


class FanoutConfigCreate(BaseModel):
    type: str = Field(description="Integration type: 'mqtt_private' or 'mqtt_community'")
    name: str = Field(min_length=1, description="User-assigned label")
    config: dict = Field(default_factory=dict, description="Type-specific config blob")
    scope: dict = Field(default_factory=dict, description="Scope controls")
    enabled: bool = Field(default=True, description="Whether enabled on creation")


class FanoutConfigResponse(BaseModel):
    """Fanout config as returned by the API (matches repository dict shape)."""

    model_config = {"extra": "allow"}

    id: str
    type: str
    name: str
    enabled: bool
    config: dict
    scope: dict
    sort_order: int
    created_at: int


class FanoutConfigUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, description="Updated label")
    config: dict | None = Field(default=None, description="Updated config blob")
    scope: dict | None = Field(default=None, description="Updated scope controls")
    enabled: bool | None = Field(default=None, description="Enable/disable toggle")


def _validate_and_normalize_config(config_type: str, config: dict) -> dict:
    """Validate a config blob and return the canonical persisted form."""
    normalized = dict(config)

    if config_type == "mqtt_private":
        _validate_mqtt_private_config(normalized)
    elif config_type == "mqtt_community":
        _validate_mqtt_community_config(normalized)
    elif config_type == "bot":
        _validate_bot_config(normalized)
    elif config_type == "webhook":
        _validate_webhook_config(normalized)
    elif config_type == "apprise":
        _validate_apprise_config(normalized)
    elif config_type == "sqs":
        _validate_sqs_config(normalized)
    elif config_type == "map_upload":
        _validate_map_upload_config(normalized)
    elif config_type == "mqtt_ha":
        _validate_mqtt_ha_config(normalized)
    elif config_type == "virtual_companion_tcp":
        _validate_virtual_companion_config(normalized)

    return normalized


def _validate_mqtt_private_config(config: dict) -> None:
    """Validate mqtt_private config blob."""
    if not config.get("broker_host"):
        raise HTTPException(status_code=400, detail="broker_host is required for mqtt_private")
    port = config.get("broker_port", 1883)
    if not isinstance(port, int) or port < 1 or port > 65535:
        raise HTTPException(status_code=400, detail="broker_port must be between 1 and 65535")


def _validate_virtual_companion_config(config: dict) -> None:
    """Normalize the plaintext listener's deliberately narrow network policy."""
    unknown = set(config) - _VIRTUAL_COMPANION_CONFIG_FIELDS
    if unknown:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported virtual Companion config field(s): {', '.join(sorted(unknown))}",
        )

    host = str(config.get("bind_host", _VIRTUAL_COMPANION_DEFAULT_HOST)).strip().lower()
    if host == "localhost":
        host = "127.0.0.1"
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        raise HTTPException(
            status_code=400,
            detail="bind_host must be a literal IPv4/IPv6 address or localhost",
        ) from None

    port = config.get("port", _VIRTUAL_COMPANION_DEFAULT_PORT)
    if type(port) is not int or not 1 <= port <= 65535:
        raise HTTPException(status_code=400, detail="port must be an integer between 1 and 65535")
    from app.config import settings as server_settings

    physical_host = (server_settings.tcp_host or "").strip().lower()
    try:
        physical_address = ipaddress.ip_address(physical_host)
        physical_is_local = physical_address.is_loopback or physical_address.is_unspecified
    except ValueError:
        physical_is_local = physical_host == "localhost"
    if physical_is_local and port == server_settings.tcp_port:
        raise HTTPException(
            status_code=400,
            detail="port must differ from a physical Companion TCP endpoint on localhost",
        )

    acknowledged = config.get("unsafe_network_acknowledged", False)
    if type(acknowledged) is not bool:
        raise HTTPException(status_code=400, detail="unsafe_network_acknowledged must be boolean")
    secure_access = str(config.get("secure_access", "")).strip().lower()
    if address.is_loopback:
        # Remote-access assertions have no effect on a loopback-only socket.
        acknowledged = False
        secure_access = ""
    elif address.compressed == "0.0.0.0" and not secure_access:
        # Default trusted-LAN mode. This is not a claim of VPN/TLS protection;
        # operators must restrict exposure with their network/firewall.
        acknowledged = False
    elif not acknowledged or secure_access not in _VIRTUAL_COMPANION_SECURE_ACCESS:
        raise HTTPException(
            status_code=400,
            detail=(
                "Custom protected Companion TCP binding requires unsafe_network_acknowledged=true and "
                "secure_access set to 'vpn' or 'mtls_proxy'. HTTP Basic auth does not protect "
                "this plaintext TCP listener."
            ),
        )

    capacity = config.get("virtual_channel_capacity", 40)
    if type(capacity) is not int or not 1 <= capacity <= 255:
        raise HTTPException(
            status_code=400,
            detail="virtual_channel_capacity must be an integer between 1 and 255",
        )
    raw_slots = config.get("channel_slots", [])
    if not isinstance(raw_slots, list) or len(raw_slots) > capacity:
        raise HTTPException(
            status_code=400,
            detail="channel_slots must be a list no longer than virtual_channel_capacity",
        )
    channel_slots: list[str | None] = []
    seen_slots: set[str] = set()
    for value in raw_slots:
        if value is None:
            channel_slots.append(None)
            continue
        if not isinstance(value, str) or not re.fullmatch(r"[0-9a-fA-F]{32}", value):
            raise HTTPException(
                status_code=400,
                detail="channel_slots entries must be null or 32-character hexadecimal keys",
            )
        key = value.upper()
        if key in seen_slots:
            raise HTTPException(status_code=400, detail="channel_slots entries must be unique")
        seen_slots.add(key)
        channel_slots.append(key)

    config.clear()
    config.update(
        {
            "bind_host": address.compressed,
            "port": port,
            "unsafe_network_acknowledged": acknowledged,
            "secure_access": secure_access,
            "virtual_channel_capacity": capacity,
            "channel_slots": channel_slots,
        }
    )


def _validate_mqtt_community_config(config: dict) -> None:
    """Validate mqtt_community config blob. Normalizes IATA to uppercase."""
    from app.fanout.packet_filter import normalize_packet_filter

    try:
        config["packet_filter"] = normalize_packet_filter(config.get("packet_filter", "all"))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    for field, default, low, high in (
        ("status_interval_minutes", 5, 1, 60),
        ("neighbors_interval_hours", 24, 12, 336),
    ):
        value = config.get(field, default)
        if type(value) is not int or not low <= value <= high:
            raise HTTPException(status_code=400, detail=f"{field} must be an integer {low}-{high}")
        config[field] = value
    for field, default in (
        ("publish_status", True),
        ("publish_packets", True),
        ("publish_neighbors", False),
    ):
        value = config.get(field, default)
        if type(value) is not bool:
            raise HTTPException(status_code=400, detail=f"{field} must be boolean")
        config[field] = value

    tx_mode = config.get("tx_mode", "off")
    if tx_mode not in ("off", "on", "advert"):
        raise HTTPException(status_code=400, detail="tx_mode must be off, on or advert")
    config["tx_mode"] = tx_mode

    broker_host = str(config.get("broker_host", _DEFAULT_COMMUNITY_MQTT_BROKER_HOST)).strip()
    if not broker_host:
        broker_host = _DEFAULT_COMMUNITY_MQTT_BROKER_HOST
    config["broker_host"] = broker_host

    port = config.get("broker_port", _DEFAULT_COMMUNITY_MQTT_BROKER_PORT)
    if not isinstance(port, int) or port < 1 or port > 65535:
        raise HTTPException(status_code=400, detail="broker_port must be between 1 and 65535")
    config["broker_port"] = port

    transport = str(config.get("transport", _DEFAULT_COMMUNITY_MQTT_TRANSPORT)).strip().lower()
    if transport not in _ALLOWED_COMMUNITY_MQTT_TRANSPORTS:
        raise HTTPException(
            status_code=400,
            detail="transport must be 'websockets' or 'tcp'",
        )
    config["transport"] = transport
    config["use_tls"] = bool(config.get("use_tls", True))
    config["tls_verify"] = bool(config.get("tls_verify", True))
    if transport == "websockets":
        websocket_path = str(config.get("websocket_path", "")).strip() or "/"
        if not websocket_path.startswith("/") or re.search(r"\s|[?#]", websocket_path):
            raise HTTPException(
                status_code=400,
                detail="websocket_path must start with / and contain no spaces, ? or #",
            )
        config["websocket_path"] = websocket_path

    auth_mode = str(config.get("auth_mode", _DEFAULT_COMMUNITY_MQTT_AUTH_MODE)).strip().lower()
    if auth_mode not in _ALLOWED_COMMUNITY_MQTT_AUTH_MODES:
        raise HTTPException(
            status_code=400,
            detail="auth_mode must be 'token', 'password', or 'none'",
        )
    config["auth_mode"] = auth_mode
    username = str(config.get("username", "")).strip()
    password = str(config.get("password", "")).strip()
    if auth_mode == "password" and (not username or not password):
        raise HTTPException(
            status_code=400,
            detail="username and password are required when auth_mode is 'password'",
        )
    config["username"] = username
    config["password"] = password

    token_audience = str(config.get("token_audience", "")).strip()
    config["token_audience"] = token_audience

    from app.fanout.community_topics import resolve_profile

    if str(config.get("broker_host", "")).lower() == "meshrank.net" and not config.get("profile"):
        config["profile"] = "meshrank"
    if resolve_profile(config) == "meshrank":
        topic = str(config.get("topic_template") or "")
        if not config.get("token") and topic:
            match = re.fullmatch(
                r"meshrank/uplink/([A-Za-z0-9_-]{8,128})/\{PUBLIC_KEY\}/packets",
                topic,
                re.IGNORECASE,
            )
            if match:
                config["token"] = match.group(1)
                config["topic_template"] = ""
        config["iata"] = ""
        config["auth_mode"] = "none"
        config["broker_host"] = "meshrank.net"
        config["broker_port"] = 8883
        config["transport"] = "tcp"
        config["use_tls"] = True
        config["tls_verify"] = True

    iata = str(config.get("iata", "")).upper().strip()
    if resolve_profile(config) in {"letsmesh", "observer"} and (
        not iata or not _IATA_RE.fullmatch(iata)
    ):
        raise HTTPException(
            status_code=400,
            detail="IATA code is required and must be exactly 3 uppercase alphabetic characters",
        )
    config["iata"] = iata

    topic_template = str(
        config.get("topic_template", _DEFAULT_COMMUNITY_MQTT_TOPIC_TEMPLATE)
    ).strip()
    if not topic_template:
        topic_template = _DEFAULT_COMMUNITY_MQTT_TOPIC_TEMPLATE

    config["topic_template"] = _normalize_community_topic_template(topic_template)
    from app.fanout.community_topics import validate_profile

    try:
        validate_profile(config)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


def _validate_bot_config(config: dict) -> None:
    """Validate bot config blob (syntax-check the code and supported signature)."""
    code = config.get("code", "")
    if not code or not code.strip():
        raise HTTPException(status_code=400, detail="Bot code cannot be empty")
    try:
        tree = ast.parse(code, filename="<bot_code>", mode="exec")
    except SyntaxError as e:
        raise HTTPException(
            status_code=400,
            detail=f"Bot code has syntax error at line {e.lineno}: {e.msg}",
        ) from None

    bot_def = next(
        (
            node
            for node in tree.body
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == "bot"
        ),
        None,
    )
    if bot_def is None:
        raise HTTPException(
            status_code=400,
            detail=(
                "Bot code must define a callable bot() function. "
                "Use the default bot template as a reference."
            ),
        )

    try:
        parameters: list[inspect.Parameter] = []
        positional_args = [
            *((arg, inspect.Parameter.POSITIONAL_ONLY) for arg in bot_def.args.posonlyargs),
            *((arg, inspect.Parameter.POSITIONAL_OR_KEYWORD) for arg in bot_def.args.args),
        ]
        positional_defaults_start = len(positional_args) - len(bot_def.args.defaults)
        sentinel_default = object()

        for index, (arg, kind) in enumerate(positional_args):
            has_default = index >= positional_defaults_start
            parameters.append(
                inspect.Parameter(
                    arg.arg,
                    kind=kind,
                    default=sentinel_default if has_default else inspect.Parameter.empty,
                )
            )
        if bot_def.args.vararg is not None:
            parameters.append(
                inspect.Parameter(bot_def.args.vararg.arg, kind=inspect.Parameter.VAR_POSITIONAL)
            )
        for kwonly_arg, kw_default in zip(
            bot_def.args.kwonlyargs, bot_def.args.kw_defaults, strict=True
        ):
            parameters.append(
                inspect.Parameter(
                    kwonly_arg.arg,
                    kind=inspect.Parameter.KEYWORD_ONLY,
                    default=(
                        sentinel_default if kw_default is not None else inspect.Parameter.empty
                    ),
                )
            )
        if bot_def.args.kwarg is not None:
            parameters.append(
                inspect.Parameter(bot_def.args.kwarg.arg, kind=inspect.Parameter.VAR_KEYWORD)
            )

        _analyze_bot_signature(inspect.Signature(parameters))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from None


def _validate_apprise_config(config: dict) -> None:
    """Validate apprise config blob."""
    urls = config.get("urls", "")
    if not urls or not urls.strip():
        raise HTTPException(status_code=400, detail="At least one Apprise URL is required")

    from app.fanout.apprise_mod import FORMAT_VARIABLES, _apply_format

    dummy_vars: dict[str, str] = dict.fromkeys(FORMAT_VARIABLES, "test")
    for field in ("body_format_dm", "body_format_channel"):
        value = config.get(field)
        if value is not None and not isinstance(value, str):
            raise HTTPException(status_code=400, detail=f"{field} must be a string")
        if isinstance(value, str) and value.strip():
            try:
                _apply_format(value, dummy_vars)
            except Exception:
                raise HTTPException(
                    status_code=400, detail=f"Invalid format string in {field}"
                ) from None

    config["markdown_format"] = bool(config.get("markdown_format", True))
    config["include_outgoing"] = bool(config.get("include_outgoing", False))


def _validate_webhook_config(config: dict) -> None:
    """Validate webhook config blob."""
    url = config.get("url", "")
    if not url:
        raise HTTPException(status_code=400, detail="url is required for webhook")
    if not url.startswith(("http://", "https://")):
        raise HTTPException(status_code=400, detail="url must start with http:// or https://")
    method = config.get("method", "POST").upper()
    if method not in ("POST", "PUT", "PATCH"):
        raise HTTPException(status_code=400, detail="method must be POST, PUT, or PATCH")
    headers = config.get("headers", {})
    if not isinstance(headers, dict):
        raise HTTPException(status_code=400, detail="headers must be a JSON object")


def _validate_sqs_config(config: dict) -> None:
    """Validate sqs config blob."""
    queue_url = str(config.get("queue_url", "")).strip()
    if not queue_url:
        raise HTTPException(status_code=400, detail="queue_url is required for sqs")
    if not queue_url.startswith(("https://", "http://")):
        raise HTTPException(status_code=400, detail="queue_url must start with http:// or https://")

    endpoint_url = str(config.get("endpoint_url", "")).strip()
    if endpoint_url and not endpoint_url.startswith(("https://", "http://")):
        raise HTTPException(
            status_code=400,
            detail="endpoint_url must start with http:// or https://",
        )

    access_key_id = str(config.get("access_key_id", "")).strip()
    secret_access_key = str(config.get("secret_access_key", "")).strip()
    session_token = str(config.get("session_token", "")).strip()
    has_static_keypair = bool(access_key_id) and bool(secret_access_key)
    has_partial_keypair = bool(access_key_id) != bool(secret_access_key)

    if has_partial_keypair:
        raise HTTPException(
            status_code=400,
            detail="access_key_id and secret_access_key must be set together for sqs",
        )
    if session_token and not has_static_keypair:
        raise HTTPException(
            status_code=400,
            detail="session_token requires access_key_id and secret_access_key for sqs",
        )


def _validate_map_upload_config(config: dict) -> None:
    """Validate and normalize map_upload config blob."""
    api_url = str(config.get("api_url", "")).strip()
    if api_url and not api_url.startswith(("http://", "https://")):
        raise HTTPException(
            status_code=400,
            detail="api_url must start with http:// or https://",
        )
    # Persist the cleaned value (empty string means use the module default)
    config["api_url"] = api_url
    config["dry_run"] = bool(config.get("dry_run", True))
    config["geofence_enabled"] = bool(config.get("geofence_enabled", False))
    try:
        radius = float(config.get("geofence_radius_km", 0) or 0)
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="geofence_radius_km must be a number") from None
    if radius < 0:
        raise HTTPException(status_code=400, detail="geofence_radius_km must be >= 0")
    config["geofence_radius_km"] = radius


def _validate_mqtt_ha_config(config: dict) -> None:
    """Validate mqtt_ha config blob."""
    if not config.get("broker_host"):
        raise HTTPException(status_code=400, detail="broker_host is required for mqtt_ha")
    port = config.get("broker_port", 1883)
    if not isinstance(port, int) or port < 1 or port > 65535:
        raise HTTPException(status_code=400, detail="broker_port must be between 1 and 65535")
    for field in ("tracked_contacts", "tracked_repeaters"):
        value = config.get(field)
        if value is not None and not isinstance(value, list):
            raise HTTPException(status_code=400, detail=f"{field} must be a list of public keys")


def _enforce_scope(config_type: str, scope: dict) -> dict:
    """Enforce type-specific scope constraints. Returns normalized scope."""
    if config_type == "mqtt_community":
        return {"messages": "none", "raw_packets": "all"}
    if config_type == "map_upload":
        return {"messages": "none", "raw_packets": "all"}
    if config_type == "bot":
        return {"messages": "all", "raw_packets": "none"}
    if config_type == "virtual_companion_tcp":
        return {"messages": "none", "raw_packets": "none"}
    if config_type in ("webhook", "apprise", "mqtt_ha"):
        messages = scope.get("messages", "all")
        if messages not in ("all", "none") and not isinstance(messages, dict):
            raise HTTPException(
                status_code=400,
                detail="scope.messages must be 'all', 'none', or a filter object",
            )
        return {"messages": messages, "raw_packets": "none"}
    # For mqtt_private and sqs, validate scope values
    messages = scope.get("messages", "all")
    if messages not in ("all", "none") and not isinstance(messages, dict):
        raise HTTPException(
            status_code=400,
            detail="scope.messages must be 'all', 'none', or a filter object",
        )
    raw_packets = scope.get("raw_packets", "all")
    if raw_packets not in ("all", "none"):
        raise HTTPException(
            status_code=400,
            detail="scope.raw_packets must be 'all' or 'none'",
        )
    return {"messages": messages, "raw_packets": raw_packets}


def _bot_system_disabled_detail() -> str | None:
    source = fanout_manager.get_bots_disabled_source()
    if source == "env":
        return "Bot system disabled by server configuration (MESHCORE_DISABLE_BOTS)"
    if source == "until_restart":
        return "Bot system disabled until the server restarts"
    return None


def _redact_fanout_config(value: dict) -> dict:
    """No token-in-topic credential may cross any readback response."""
    result = dict(value)
    if result.get("type") == "mqtt_community":
        config = dict(result["config"])
        configured = bool(config.pop("token", ""))
        config["token_configured"] = configured
        result["config"] = config
    return result


@router.get("", response_model=list[FanoutConfigResponse])
async def list_fanout_configs() -> list[FanoutConfigResponse]:
    """List all fanout configs."""
    configs = await FanoutConfigRepository.get_all()
    return [_redact_fanout_config(cfg) for cfg in configs]  # type: ignore[return-value]


@router.post("", response_model=FanoutConfigResponse)
async def create_fanout_config(body: FanoutConfigCreate) -> FanoutConfigResponse:
    """Create a new fanout config."""
    if body.type not in _VALID_TYPES:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid type '{body.type}'. Must be one of: {', '.join(sorted(_VALID_TYPES))}",
        )

    if body.type == "bot":
        disabled_detail = _bot_system_disabled_detail()
        if disabled_detail:
            raise HTTPException(status_code=403, detail=disabled_detail)

    normalized_config = _validate_and_normalize_config(body.type, body.config)
    scope = _enforce_scope(body.type, body.scope)

    enabled = body.enabled
    if body.type == "virtual_companion_tcp" and "enabled" not in body.model_fields_set:
        enabled = False
    try:
        cfg = await FanoutConfigRepository.create(
            config_type=body.type,
            name=body.name,
            config=normalized_config,
            scope=scope,
            enabled=enabled,
        )
    except sqlite3.IntegrityError as exc:
        if body.type != "virtual_companion_tcp":
            raise
        raise HTTPException(
            status_code=409,
            detail="Only one virtual Companion TCP integration may be configured",
        ) from exc

    # Start the module if enabled
    if cfg["enabled"]:
        start_error = await fanout_manager.reload_config(cfg["id"])
        if start_error and body.type == "virtual_companion_tcp":
            await fanout_manager.remove_config(cfg["id"])
            await FanoutConfigRepository.delete(cfg["id"])
            raise HTTPException(status_code=409, detail=start_error)

    logger.info("Created fanout config %s (type=%s, name=%s)", cfg["id"], body.type, body.name)
    return _redact_fanout_config(cfg)  # type: ignore[return-value]


@router.patch("/{config_id}", response_model=FanoutConfigResponse)
async def update_fanout_config(config_id: str, body: FanoutConfigUpdate) -> FanoutConfigResponse:
    """Update a fanout config. Triggers module reload."""
    existing = await FanoutConfigRepository.get(config_id)
    if existing is None:
        raise HTTPException(status_code=404, detail="Fanout config not found")

    if existing["type"] == "bot":
        disabled_detail = _bot_system_disabled_detail()
        if disabled_detail:
            raise HTTPException(status_code=403, detail=disabled_detail)

    kwargs = {}
    if body.name is not None:
        kwargs["name"] = body.name
    if body.enabled is not None:
        kwargs["enabled"] = body.enabled
    if body.scope is not None:
        kwargs["scope"] = _enforce_scope(existing["type"], body.scope)

    config_to_validate = dict(body.config) if body.config is not None else dict(existing["config"])
    if (
        existing["type"] == "mqtt_community"
        and not config_to_validate.get("token")
        and existing["config"].get("token")
    ):
        config_to_validate["token"] = existing["config"]["token"]
    kwargs["config"] = _validate_and_normalize_config(existing["type"], config_to_validate)

    updated = await FanoutConfigRepository.update(config_id, **kwargs)
    if updated is None:
        raise HTTPException(status_code=404, detail="Fanout config not found")

    # Reload the module to pick up changes
    start_error = await fanout_manager.reload_config(config_id)
    if start_error and existing["type"] == "virtual_companion_tcp":
        await FanoutConfigRepository.update(
            config_id,
            name=existing["name"],
            enabled=existing["enabled"],
            config=existing["config"],
            scope=existing["scope"],
            sort_order=existing["sort_order"],
        )
        await fanout_manager.reload_config(config_id)
        raise HTTPException(status_code=409, detail=start_error)

    logger.info("Updated fanout config %s", config_id)
    return _redact_fanout_config(updated)  # type: ignore[return-value]


@router.delete("/{config_id}")
async def delete_fanout_config(config_id: str) -> dict:
    """Delete a fanout config."""
    existing = await FanoutConfigRepository.get(config_id)
    if existing is None:
        raise HTTPException(status_code=404, detail="Fanout config not found")

    # Stop the module first
    await fanout_manager.remove_config(config_id)
    await FanoutConfigRepository.delete(config_id)

    logger.info("Deleted fanout config %s", config_id)
    return {"deleted": True}


@router.post("/bots/disable-until-restart")
async def disable_bots_until_restart() -> dict:
    """Stop active bot modules and prevent them from running again until restart."""
    source = await fanout_manager.disable_bots_until_restart()

    from app.services.radio_runtime import radio_runtime as radio_manager
    from app.websocket import broadcast_health

    broadcast_health(radio_manager.is_connected, radio_manager.connection_info)
    return {
        "status": "ok",
        "bots_disabled": True,
        "bots_disabled_source": source,
    }
