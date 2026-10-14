"""Persistent *host-sampled* zero-hop observations, not a firmware neighbor table."""

from __future__ import annotations

import json
import logging
import re
import time
from collections.abc import Sequence
from typing import Any

from app.database import db

logger = logging.getLogger(__name__)

_FULL_KEY = re.compile(r"^[0-9a-fA-F]{64}$")
OBSERVATION_TTL_SECS = 48 * 3600
NEIGHBOR_SNAPSHOT_MAX_BYTES = 48 * 1024


def valid_full_key(key: object) -> bool:
    return isinstance(key, str) and bool(_FULL_KEY.fullmatch(key))


async def observe_discovery(
    public_key: str,
    node_type: str,
    *,
    local_snr: float | None = None,
    local_rssi: int | None = None,
    remote_snr: float | None = None,
    now: int | None = None,
) -> bool:
    """Only correlated *full-key* zero-hop discovery can create a neighbor row."""
    if not valid_full_key(public_key) or node_type not in {"repeater", "sensor"}:
        return False
    now = int(time.time()) if now is None else now
    try:
        async with db.tx() as conn:
            await conn.execute(
                """INSERT INTO community_observed_neighbors
            (public_key, first_seen, last_seen, last_discovery_at, source, node_type,
             local_snr, local_rssi, remote_snr)
            VALUES (?, ?, ?, ?, 'tagged_zero_hop_discover', ?, ?, ?, ?)
            ON CONFLICT(public_key) DO UPDATE SET
                last_seen=MAX(last_seen, excluded.last_seen),
                last_discovery_at=MAX(last_discovery_at, excluded.last_discovery_at),
                local_snr=COALESCE(excluded.local_snr, local_snr),
                local_rssi=COALESCE(excluded.local_rssi, local_rssi),
                remote_snr=COALESCE(excluded.remote_snr, remote_snr),
                node_type=excluded.node_type""",
                (public_key.lower(), now, now, now, node_type, local_snr, local_rssi, remote_snr),
            )
    except RuntimeError:
        logger.warning("observe_discovery: database not available, observation skipped")
        return False
    return True


async def record_scope_result(
    public_key: str, names: Sequence[str] | None, *, now: int | None = None
) -> None:
    """Never replace known scopes with an empty set after an unanswered query."""
    if not valid_full_key(public_key):
        return
    now = int(time.time()) if now is None else now
    scopes = sorted({name.strip() for name in names or () if name.strip() and name != "*"})
    try:
        async with db.tx() as conn:
            await conn.execute(
                """UPDATE community_observed_neighbors SET scope_queried_at=?,
                   scope_status=?, scope_names=CASE WHEN ? THEN ? ELSE scope_names END
                   WHERE public_key=? AND node_type='repeater'""",
                (
                    now,
                    "responded" if names is not None else "timeout",
                    names is not None,
                    json.dumps(scopes),
                    public_key.lower(),
                ),
            )
    except RuntimeError:
        logger.warning("record_scope_result: database not available, result skipped")


async def get_recent_observations(*, now: int | None = None) -> list[dict[str, Any]]:
    now = int(time.time()) if now is None else now
    try:
        async with db.readonly() as conn:
            async with conn.execute(
                """SELECT * FROM community_observed_neighbors WHERE last_seen >= ?
                   ORDER BY last_seen DESC, public_key ASC""",
                (now - OBSERVATION_TTL_SECS,),
            ) as cursor:
                return [dict(row) for row in await cursor.fetchall()]
    except RuntimeError:
        logger.warning("get_recent_observations: database not available")
        return []


def build_observed_neighbors_payload(
    observations: list[dict[str, Any]],
    origin: str,
    public_key: str,
    *,
    now: int | None = None,
    max_bytes: int = NEIGHBOR_SNAPSHOT_MAX_BYTES,
    default_scope: str | None = None,
) -> dict[str, Any]:
    """Truthful sample: total counts refer only to recent host observations."""
    now = int(time.time()) if now is None else now
    recent = [
        row
        for row in observations
        if valid_full_key(row.get("public_key"))
        and isinstance(row.get("last_seen"), int)
        and now - OBSERVATION_TTL_SECS <= row["last_seen"] <= now
    ]
    result: dict[str, Any] = {
        "timestamp": __import__("datetime")
        .datetime.fromtimestamp(now, __import__("datetime").UTC)
        .isoformat()
        .replace("+00:00", "Z"),
        "origin": origin or "MeshCore Device",
        "origin_id": public_key.upper(),
        "sample_type": "host_observed_nearby",
        "total_neighbors": len(recent),
        "queried_neighbors": sum(
            row.get("scope_status") in {"responded", "timeout", "send_failed"} for row in recent
        ),
        "truncated": False,
        # Companion does not export an authoritative self.scopes list.
        "self": ({"default_scope": default_scope} if default_scope else {}),
        "neighbors": [],
    }
    for row in sorted(recent, key=lambda r: (-r["last_seen"], r["public_key"])):
        status = row.get("scope_status") or "not_queried"
        entry = {
            "pubkey": row["public_key"].upper(),
            "snr": row.get("local_snr"),
            "heard_secs_ago": now - row["last_seen"],
            "scopes": json.loads(row["scope_names"]) if row.get("scope_names") else None,
            "status": status,
        }
        result["neighbors"].append(entry)
        if len(json.dumps(result, separators=(",", ":")).encode()) > max_bytes:
            result["neighbors"].pop()
            result["truncated"] = True
            break
    result["truncated"] = result["truncated"] or len(result["neighbors"]) < len(recent)
    return result
