"""Capture the migration oracle without starting lifespan, radio or integrations.

Only creates a new temporary SQLite database. Never accepts an operator DB path.
Run: PYTHONPATH=. uv run python scripts/migration/capture_baseline.py OUTPUT_DIR
Frozen artifacts are reviewed, never refreshed by the normal quality gate.
"""

from __future__ import annotations

import argparse
import ast
import asyncio
import importlib
import json
import tempfile
from contextlib import ExitStack
from pathlib import Path
from unittest.mock import patch

import httpx

ROOT = Path(__file__).resolve().parents[2]
BASELINE = ROOT / "tests/fixtures/migration/python-v72"
REFERENCE = "68647d0fa2439a6f47dbb53e3614df9f6aaf013e"

# These requests cannot enqueue jobs or mutate radio/integration state.
REQUESTS = [
    ("GET", "/api/contacts"),
    ("GET", "/api/channels"),
    ("GET", "/api/messages"),
    ("GET", "/api/read-state/unreads"),
    ("GET", "/api/contacts?limit=0"),
    ("GET", "/api/contacts?limit=1001"),
    ("GET", "/api/messages?limit=invalid"),
]


def write_json(path: Path, value: object) -> None:
    path.write_text(json.dumps(value, indent=2, sort_keys=True, ensure_ascii=False) + "\n")


def first_difference(expected: object, actual: object, path: str = "$") -> str | None:
    """Report a field/index, never its potentially private value."""
    if type(expected) is not type(actual):
        return path + " (type)"
    if isinstance(expected, dict):
        if expected.keys() != actual.keys():
            return path + " (keys)"
        for key in expected:
            difference = first_difference(expected[key], actual[key], f"{path}.{key}")
            if difference:
                return difference
    elif isinstance(expected, list):
        if len(expected) != len(actual):
            return path + " (length)"
        for index, (left, right) in enumerate(zip(expected, actual, strict=True)):
            difference = first_difference(left, right, f"{path}[{index}]")
            if difference:
                return difference
    elif expected != actual:
        return path + " (value)"
    return None


def inventory() -> dict:
    """Mechanical inventory: no uncovered module disappears behind a percentage."""
    from app.config import Settings
    from app.main import app
    from app.models import AppSettings

    modules = {}
    for source in sorted((ROOT / "app").rglob("*.py")):
        tree = ast.parse(source.read_text())
        functions = sorted(
            node.name for node in ast.walk(tree) if isinstance(node, ast.AsyncFunctionDef)
        )
        modules[str(source.relative_to(ROOT))] = functions
    return {
        "reference_commit": REFERENCE,
        "capture_commit": "075064e8d0cc428c39ff7607424e91ef93b3ce0e",
        "schema_version": 72,
        "routes": sorted(
            f"{method} {route.path}"
            for route in app.routes
            for method in sorted(getattr(route, "methods", None) or [])
            if route.path.startswith("/api")
        ),
        "environment_settings": sorted(Settings.model_fields),
        "persisted_settings": sorted(AppSettings.model_fields),
        "async_functions_by_module": modules,
        "coverage_note": "Inventory is not proof of parity. See docs/migration/PHASE_A.md.",
    }


async def create_sqlite_fixture(path: Path) -> None:
    """Build a synthetic, fully migrated file; refuse to overwrite anything."""
    from app.database import Database

    if path.exists():
        raise FileExistsError("Fixture destination must not already exist")
    database = Database(str(path))
    try:
        await database.connect()
        async with database.readonly() as conn:
            async with conn.execute("PRAGMA wal_checkpoint(TRUNCATE)") as cursor:
                row = await cursor.fetchone()
                if row[0] != 0:
                    raise RuntimeError("Fixture checkpoint busy")
    finally:
        await database.disconnect()


async def replay_storage(database) -> dict:
    """Deterministic repository oracle; only synthetic labels, no RF plaintext."""
    from app.repository.messages import MessageRepository as Messages
    from app.repository.raw_packets import RawPacketRepository as Packets

    async with database.tx() as conn:
        await conn.execute(
            "INSERT INTO contacts(public_key, name) VALUES ('fixture-peer', 'Fixture Peer')"
        )
        await conn.execute("INSERT INTO channels(key, name) VALUES ('fixture-channel', '#fixture')")
    created = []
    for index, (text, timestamp) in enumerate(
        [("Alpha 100%_", 1000), ("alphabet", 1000), ("historical", 900)], start=1
    ):
        created.append(
            await Messages.create(
                "CHAN",
                text,
                timestamp,
                "fixture-channel",
                sender_timestamp=timestamp,
                sender_name="Fixture Peer",
                sender_key="fixture-peer",
                wire_packet_id=index,
            )
        )
    queries = ["alpha", "%_", 'channel:"#fixture"', 'user:"Fixture Peer" alpha', "historical"]
    searches = {query: [row.id for row in await Messages.get_all(q=query)] for query in queries}
    pending = await Messages.create(
        "PRIV", "synthetic-pending", 1000, "fixture-peer", outgoing=True, send_status="pending"
    )
    recovered = await Messages.recover_interrupted_outgoing_sends()
    recovered_again = await Messages.recover_interrupted_outgoing_sends()
    outgoing = await Messages.get_by_id(pending)
    # Actual baseline deviation: fallback matching currently omits sender_key.
    first_room = await Messages.create(
        "PRIV",
        "synthetic-room",
        1000,
        "fixture-room",
        sender_timestamp=1000,
        sender_key="fixture-sender-a",
    )
    second_room = await Messages.create(
        "PRIV",
        "synthetic-room",
        1000,
        "fixture-room",
        sender_timestamp=1000,
        sender_key="fixture-sender-b",
    )
    packet = bytes([9, 0]) + bytes(range(16))
    packet_first = await Packets.create(packet, timestamp=1000)
    packet_repeat = await Packets.create(bytes([9, 1, 42]) + packet[2:], timestamp=1001)
    async with database.tx() as conn:
        await conn.execute(
            "UPDATE channels SET last_read_at=1000, last_read_message_id=? "
            "WHERE key='fixture-channel'",
            (created[0],),
        )
    return {
        "created": created,
        "searches": searches,
        "same_second_page": [
            row.id
            for row in await Messages.get_all(
                conversation_key="fixture-channel", before=1000, before_id=created[1]
            )
        ],
        "unreads": await Messages.get_unread_counts(),
        "recovery": {"first": recovered, "second": recovered_again, "status": outgoing.send_status},
        "room_fallback": {"first": first_room, "second": second_room},
        "packet_first": list(packet_first),
        "packet_repeat": list(packet_repeat),
    }


async def capture(output: Path) -> None:
    from app.database import Database
    from app.main import app
    from scripts.build.dump_api_specs import dump_openapi, dump_ws_events

    output.mkdir(parents=True, exist_ok=True)
    dump_openapi(output)
    dump_ws_events(output)
    write_json(output / "inventory.json", inventory())
    with tempfile.TemporaryDirectory(prefix="meshrik-baseline-") as directory:
        database = Database(str(Path(directory) / "fixture.db"))
        try:
            await database.connect()
            async with database.readonly() as conn:
                async with conn.execute(
                    "SELECT type, name, tbl_name, sql FROM sqlite_master "
                    "WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY type, name"
                ) as cursor:
                    write_json(
                        output / "schema.json", [dict(row) for row in await cursor.fetchall()]
                    )
                async with conn.execute("PRAGMA user_version") as cursor:
                    assert (await cursor.fetchone())[0] == 72

            with ExitStack() as patches:
                for source in sorted((ROOT / "app/repository").glob("*.py")):
                    module = importlib.import_module(f"app.repository.{source.stem}")
                    if hasattr(module, "db"):
                        patches.enter_context(patch.object(module, "db", database))
                responses = []
                async with httpx.AsyncClient(
                    transport=httpx.ASGITransport(app=app), base_url="http://fixture"
                ) as client:
                    for method, path in REQUESTS:
                        response = await client.request(method, path)
                        responses.append(
                            {
                                "method": method,
                                "path": path,
                                "status": response.status_code,
                                "content_type": response.headers.get("content-type"),
                                "body": response.json(),
                            }
                        )
                write_json(output / "responses.json", responses)
                write_json(output / "storage-replay.json", await replay_storage(database))
        finally:
            await database.disconnect()


async def compare_http(base_url: str) -> list[str]:
    """Run the frozen read cases against an already isolated fixture server.

    The caller starts/stops the backend with a disposable empty database and
    disabled radio/integrations. This command never launches a production app.
    """
    failures = []
    async with httpx.AsyncClient(base_url=base_url, trust_env=False) as client:
        for case in json.loads((BASELINE / "responses.json").read_text()):
            response = await client.request(case["method"], case["path"])
            try:
                body = response.json()
            except ValueError:
                failures.append(f"{case['path']}: response is not JSON")
                continue
            actual = {
                **case,
                "body": body,
                "status": response.status_code,
                "content_type": response.headers.get("content-type"),
            }
            difference = first_difference(case, actual)
            if difference:
                failures.append(f"{case['method']} {case['path']}: {difference}")
    return failures


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path, nargs="?")
    parser.add_argument("--compare-http", metavar="ISOLATED_BASE_URL")
    arguments = parser.parse_args()
    if arguments.compare_http:
        differences = asyncio.run(compare_http(arguments.compare_http))
        print("\n".join(differences) if differences else "All frozen HTTP cases match")
        raise SystemExit(bool(differences))
    if arguments.output is None:
        parser.error("OUTPUT_DIR is required for capture")
    asyncio.run(capture(arguments.output))
