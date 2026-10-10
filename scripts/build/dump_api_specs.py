#!/usr/bin/env python3
"""Dump the REST OpenAPI spec and WebSocket event schemas to JSON files.

These artifacts are generated programmatically from the running codebase so
they stay in sync with the actual API and WS contracts. They're intended for
consumption by external integrations (e.g., Home Assistant) that need a stable
reference without reading our source.

Usage:
    uv run python scripts/build/dump_api_specs.py [output_dir] [--openapi-only]

Output (default: references/ha/):
    openapi.json        — Full OpenAPI 3.x spec for all REST endpoints
    ws_events.json      — JSON Schema for each WebSocket event type
"""

import argparse
import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))


def _json_text(value: object) -> str:
    """Serialize generated contracts deterministically for drift checks."""
    return json.dumps(value, indent=2, sort_keys=True, ensure_ascii=False) + "\n"


def dump_openapi(output_dir: Path) -> None:
    from app.main import app

    schema = app.openapi()
    out = output_dir / "openapi.json"
    out.write_text(_json_text(schema), encoding="utf-8", newline="\n")
    print(
        f"  openapi.json: {len(schema['paths'])} paths, "
        f"{len(schema.get('components', {}).get('schemas', {}))} schemas"
    )


def dump_ws_events(output_dir: Path) -> None:
    from app.events import _PAYLOAD_ADAPTERS

    events: dict = {}
    for event_type, adapter in _PAYLOAD_ADAPTERS.items():
        schema = adapter.json_schema()
        events[event_type] = {
            "description": _event_descriptions().get(event_type, ""),
            "payload_schema": schema,
        }

    wrapper = {
        "$comment": (
            "Auto-generated from app/events.py. "
            'Each WebSocket message is a JSON object: {"type": "<event_type>", "data": <payload>}. '
            'The client also sends "ping" as plain text; the server replies {"type": "pong"}.'
        ),
        "events": events,
    }

    out = output_dir / "ws_events.json"
    out.write_text(_json_text(wrapper), encoding="utf-8", newline="\n")
    print(f"  ws_events.json: {len(events)} event types")


def _event_descriptions() -> dict[str, str]:
    return {
        "health": "Radio connection status. Sent on WS connect and on every state change.",
        "message": "New or incoming message (DM or channel). Includes outgoing messages sent by this radio.",
        "contact": "Contact created or updated (from advertisements, radio sync, or API).",
        "contact_resolved": "A prefix-only placeholder contact was resolved to a full public key.",
        "channel": "Channel created or updated.",
        "contact_deleted": "A contact was removed from the database.",
        "channel_deleted": "A channel was removed from the database.",
        "raw_packet": "Every incoming RF packet (pre-decryption). Use observation_id as the dedup key, not id.",
        "message_acked": "An existing message received an ACK or echo/repeat update.",
        "error": "Toast-level error notification (e.g., radio setup failure, missing private key).",
        "success": "Toast-level success notification (e.g., historical decrypt complete).",
        "radio_job": "Sanitized job snapshot delta. Merge by ID/version; refetch jobs after WebSocket reconnect.",
        "radio_activity": "Sanitized inbound radio observation, deduplicate by sequence; refetch activity after reconnect.",
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output_dir", nargs="?", default="references/ha", type=Path)
    parser.add_argument(
        "--openapi-only",
        action="store_true",
        help="Skip WebSocket schemas when generating the frontend REST contract",
    )
    args = parser.parse_args()
    output_dir: Path = args.output_dir
    output_dir.mkdir(parents=True, exist_ok=True)

    print(f"Dumping API specs to {output_dir}/")
    dump_openapi(output_dir)
    if not args.openapi_only:
        dump_ws_events(output_dir)
    print("Done.")


if __name__ == "__main__":
    main()
