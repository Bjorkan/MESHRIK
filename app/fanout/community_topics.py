"""Validated per-integration Community MQTT broker wire contract.

Never log rendered MeshRank topics: they contain an operator credential.
"""

from __future__ import annotations

import re

_PUBKEY = re.compile(r"^[0-9A-Fa-f]{64}$")
_IATA = re.compile(r"^[A-Z]{3}$")
_TOKEN = re.compile(r"^[A-Za-z0-9_-]{8,128}$")
_TYPES = {"status", "packets", "neighbors"}
_RESERVED = {"raw", "error", "internal", "serial"}


def resolve_profile(config: dict) -> str:
    profile = str(config.get("profile") or "").lower()
    if not profile:
        template = str(config.get("topic_template", ""))
        profile = (
            "custom" if template and not template.startswith("meshcore/{IATA}/") else "letsmesh"
        )
    if profile not in {"letsmesh", "meshrank", "custom"}:
        raise ValueError("profile: unsupported MQTT broker profile")
    return profile


def validate_profile(config: dict) -> None:
    """Fail closed before any MQTT connect or publication."""
    profile = resolve_profile(config)
    if profile == "letsmesh":
        iata = str(config.get("iata") or "").strip().upper()
        if not _IATA.fullmatch(iata) or iata in {"XXX", "XYZ"}:
            raise ValueError("iata: enter an approved three-letter ingress code (not XXX/XYZ)")
        allowed = config.get("allowed_iata")
        if allowed is not None and iata not in allowed:
            raise ValueError("iata: code not in configured ingress allowlist")
    elif profile == "meshrank":
        if not _TOKEN.fullmatch(str(config.get("token") or "")):
            raise ValueError("token: MeshRank requires a token (8-128 URL-safe characters)")
    else:
        template = str(config.get("topic_template") or "")
        if not template.endswith("/packets"):
            raise ValueError("topic_template: custom namespace must end with /packets")
        if any(char in template for char in ("+", "#", "\x00")):
            raise ValueError("topic_template: invalid MQTT path")
        for field in re.findall(r"\{([^{}]+)\}", template):
            if field.upper() not in {"IATA", "PUBLIC_KEY"}:
                raise ValueError("topic_template: unsupported placeholder")
        if "{PUBLIC_KEY}" not in template.upper():
            raise ValueError("topic_template: must contain {PUBLIC_KEY}")


def community_topic(config: dict, public_key: str, kind: str) -> str:
    validate_profile(config)
    if not _PUBKEY.fullmatch(public_key):
        raise ValueError("public_key: must be the radio's complete 64-hex identity")
    if kind not in _TYPES:
        raise ValueError("topic: unsupported or broker-reserved subtopic")
    profile = resolve_profile(config)
    pubkey = public_key.upper()
    if profile == "letsmesh":
        return f"meshcore/{str(config['iata']).strip().upper()}/{pubkey}/{kind}"
    if profile == "meshrank":
        return f"meshrank/uplink/{config['token']}/{pubkey}/{kind}"
    template = str(config["topic_template"])
    topic = template.replace("{PUBLIC_KEY}", pubkey).replace("{public_key}", pubkey)
    topic = topic.replace("{IATA}", str(config.get("iata", "")).upper())
    topic = topic.replace("{iata}", str(config.get("iata", "")).upper())
    topic = topic[: -len("packets")] + kind
    if any(not segment or segment in _RESERVED for segment in topic.split("/")):
        raise ValueError("topic_template: reserved or empty segment")
    return topic


def broker_retains(config: dict, kind: str) -> bool:
    """LetsMesh itself retains exact neighbors; the sender must not force it."""
    return resolve_profile(config) == "custom" and kind in {"status", "neighbors"}


def error_subscriptions(config: dict, public_key: str) -> tuple[str, ...]:
    """Only private self-key diagnostics; never wildcard subscriptions."""
    if resolve_profile(config) != "letsmesh":
        return ()
    topic = community_topic(config, public_key, "status")
    prefix = topic.rsplit("/", 1)[0]
    return (f"{prefix}/error", f"meshcore/XXX/{public_key.upper()}/error")
