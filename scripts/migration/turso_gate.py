"""Run native Turso against disposable copies of the Python v72 oracle.

No operator database input exists. SQLite creates/checkpoints/closes synthetic
files before the native process receives their bytes. Each scenario runs in a
separate bounded process, so a native panic cannot masquerade as compatibility.
"""

from __future__ import annotations

import argparse
import asyncio
import copy
import importlib
import json
import shutil
import sqlite3
import subprocess
import tempfile
from contextlib import ExitStack, asynccontextmanager
from pathlib import Path
from unittest.mock import patch

from scripts.migration.capture_baseline import (
    BASELINE,
    ROOT,
    create_sqlite_fixture,
    first_difference,
    replay_storage,
    write_json,
)

KNOWN = ROOT / "tests/fixtures/migration/turso-0.8.3.json"


def sql_value(value):
    if value is None:
        return {"type": "null"}
    if isinstance(value, bytes):
        return {"type": "blob", "value": list(value)}
    if isinstance(value, (bool, int)):
        return {"type": "integer", "value": int(value)}
    if isinstance(value, float):
        return {"type": "real", "value": value}
    if isinstance(value, str):
        return {"type": "text", "value": value}
    raise TypeError("Unsupported fixture parameter type")


def operation(sql, params=()):
    return {"sql": sql, "params": [sql_value(value) for value in params]}


async def repository_operations(path: Path) -> list[dict]:
    """Record actual SQL/params/transaction boundaries, not expanded trace SQL.

    SQLite trace callbacks repeat trigger statements and would replay duplicate
    mutations. Recording the Python connection API avoids that ambiguity.
    """
    from app.database import Database

    database = Database(str(path))
    operations = []
    try:
        await database.connect()
        original_execute = database.conn.execute
        original_tx = database.tx

        def execute(sql, params=()):
            operations.append(operation(sql, params))
            return original_execute(sql, params)

        @asynccontextmanager
        async def transaction():
            async with original_tx() as conn:
                operations.append(operation("BEGIN"))
                try:
                    yield conn
                except BaseException:
                    operations.append(operation("ROLLBACK"))
                    raise
                else:
                    operations.append(operation("COMMIT"))

        with ExitStack() as patches:
            for source in sorted((ROOT / "app/repository").glob("*.py")):
                module = importlib.import_module(f"app.repository.{source.stem}")
                if hasattr(module, "db"):
                    patches.enter_context(patch.object(module, "db", database))
            patches.enter_context(patch.object(database.conn, "execute", execute))
            patches.enter_context(patch.object(database, "tx", transaction))
            await replay_storage(database)
    finally:
        await database.disconnect()
    return operations


def scenarios(replay: list[dict]) -> list[dict]:
    cases = []

    def add(name, statements, *, fresh=False, read_only=False):
        cases.append(
            {
                "name": name,
                "fresh": fresh,
                "read_only": read_only,
                "operations": [operation(sql) for sql in statements],
            }
        )

    add(
        "v72.schema",
        [
            "PRAGMA user_version",
            "SELECT type,name,tbl_name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name",
            "SELECT COUNT(*) FROM channels",
        ],
    )
    pragmas = {
        "journal_mode": ("WAL",),
        "synchronous": ("NORMAL",),
        "busy_timeout": ("5000",),
        "cache_size": ("-64000",),
        "temp_store": ("MEMORY",),
        "foreign_keys": ("ON",),
        "auto_vacuum": ("INCREMENTAL",),
    }
    for pragma, (setting,) in pragmas.items():
        add(f"pragma.{pragma}", [f"PRAGMA {pragma}={setting}", f"PRAGMA {pragma}"])
    add(
        "maintenance.incremental_vacuum",
        ["PRAGMA freelist_count", "PRAGMA incremental_vacuum", "PRAGMA freelist_count"],
    )
    add("maintenance.vacuum", ["VACUUM", "PRAGMA integrity_check"])
    add(
        "maintenance.foreign_key_check",
        [
            "PRAGMA foreign_keys=OFF",
            "INSERT INTO pending_dm_ack_correlations(code,message_id,radio_key,expiry_at) VALUES('fixture',999,'fixture',2000)",
            "PRAGMA foreign_key_check",
        ],
    )
    add("wal.checkpoint", ["PRAGMA wal_checkpoint(TRUNCATE)", "PRAGMA user_version"])
    add(
        "readonly.dry_run",
        ["PRAGMA user_version", "UPDATE app_settings SET max_radio_contacts=201 WHERE id=1"],
        read_only=True,
    )
    ddl = json.loads((BASELINE / "schema.json").read_text())
    statements = ["PRAGMA foreign_keys=ON"]
    for kind in ("table", "index", "trigger"):
        statements.extend(item["sql"] for item in ddl if item["type"] == kind)
    statements += ["PRAGMA user_version=72", "PRAGMA user_version"]
    statements += [f"PRAGMA table_info({item['name']})" for item in ddl if item["type"] == "table"]
    add("fresh.v72_ddl", statements, fresh=True)
    add(
        "contacts.triggers_upsert_rollback_tombstone",
        [
            "UPDATE virtual_companion_contact_clock SET revision=2000000000 WHERE singleton=1",
            "INSERT INTO contacts(public_key,name) VALUES('fixture-peer','fixture')",
            "SELECT revision,deleted FROM virtual_companion_contact_changes WHERE public_key='fixture-peer'",
            "UPDATE contacts SET name='fixture-update' WHERE public_key='fixture-peer'",
            "SELECT revision,deleted FROM virtual_companion_contact_changes WHERE public_key='fixture-peer'",
            "BEGIN",
            "DELETE FROM contacts WHERE public_key='fixture-peer'",
            "ROLLBACK",
            "SELECT revision,deleted FROM virtual_companion_contact_changes WHERE public_key='fixture-peer'",
            "INSERT INTO contacts(public_key,name) VALUES('fixture-peer','fixture-upsert') ON CONFLICT(public_key) DO UPDATE SET name=excluded.name",
            "SELECT revision,deleted FROM virtual_companion_contact_changes WHERE public_key='fixture-peer'",
            "DELETE FROM contacts WHERE public_key='fixture-peer'",
            "SELECT revision,deleted FROM virtual_companion_contact_changes WHERE public_key='fixture-peer'",
            "SELECT revision FROM virtual_companion_contact_clock",
        ],
    )
    add(
        "foreign_keys.cascade_and_enforcement",
        [
            "PRAGMA foreign_keys=ON",
            "INSERT INTO contacts(public_key) VALUES('fixture-peer')",
            "INSERT INTO contact_name_history(public_key,name,first_seen,last_seen) VALUES('fixture-peer','fixture',1000,1000)",
            "INSERT INTO contact_name_history(public_key,name,first_seen,last_seen) VALUES('missing','fixture',1000,1000)",
            "DELETE FROM contacts WHERE public_key='fixture-peer'",
            "SELECT COUNT(*) FROM contact_name_history",
        ],
    )
    add(
        "foreign_keys.set_null_and_pending_ack_cascade",
        [
            "PRAGMA foreign_keys=ON",
            "INSERT INTO messages(type,conversation_key,text,received_at) VALUES('PRIV','fixture','synthetic',1000)",
            "INSERT INTO raw_packets(timestamp,data,message_id,payload_hash) VALUES(1000,x'010203',1,x'040506')",
            "INSERT INTO pending_dm_ack_correlations(code,message_id,radio_key,expiry_at) VALUES('fixture',1,'fixture',2000)",
            "DELETE FROM messages WHERE id=1",
            "SELECT message_id,hex(data),hex(payload_hash) FROM raw_packets",
            "SELECT COUNT(*) FROM pending_dm_ack_correlations",
        ],
    )
    add(
        "transactions.ingress_send_recovery",
        [
            "BEGIN IMMEDIATE",
            "INSERT INTO pending_radio_ingress(kind,payload,created_at) VALUES('CHAN','{}',1000)",
            "INSERT INTO messages(type,conversation_key,text,received_at,outgoing,send_status) VALUES('CHAN','fixture','synthetic',1000,1,'pending')",
            "ROLLBACK",
            "SELECT COUNT(*) FROM pending_radio_ingress",
            "SELECT COUNT(*) FROM messages",
            "BEGIN IMMEDIATE",
            "INSERT INTO messages(type,conversation_key,text,received_at,outgoing,send_status) VALUES('CHAN','fixture','synthetic',1000,1,'pending')",
            "COMMIT",
            "UPDATE messages SET send_status='unknown' WHERE outgoing=1 AND send_status='pending'",
            "SELECT id,send_status,acked FROM messages",
        ],
    )
    add(
        "transactions.savepoint",
        [
            "BEGIN",
            "SAVEPOINT fixture",
            "INSERT INTO channels(key,name) VALUES('fixture','fixture')",
            "ROLLBACK TO fixture",
            "RELEASE fixture",
            "COMMIT",
            "SELECT COUNT(*) FROM channels WHERE key='fixture'",
        ],
    )
    add(
        "queries.window_json_blob",
        [
            "SELECT ROW_NUMBER() OVER (ORDER BY value DESC) FROM (SELECT 1 AS value UNION ALL SELECT 2)",
            "SELECT json_extract('{\"fixture\": [1,2]}', '$.fixture[1]')",
            "SELECT x'00ff80', typeof(x'00ff80'), hex(x'00ff80')",
            "SELECT 'Alpha' LIKE '%alpha%' COLLATE NOCASE",
        ],
    )
    add("text.invalid_utf8", ["SELECT CAST(x'ff80' AS TEXT)"])
    add(
        "indexes.partial_expression",
        [
            "INSERT INTO fanout_configs(id,type,name,config,scope,created_at) VALUES('fixture-a','virtual_companion_tcp','fixture','{}','{}',1000)",
            "INSERT INTO fanout_configs(id,type,name,config,scope,created_at) VALUES('fixture-b','virtual_companion_tcp','fixture','{}','{}',1000)",
            "INSERT INTO contacts(public_key) VALUES('FIXTURE')",
            "SELECT COUNT(*) FROM contacts WHERE lower(public_key)='fixture'",
        ],
    )
    cases.append(
        {
            "name": "repository.actual_sql_replay",
            "fresh": False,
            "read_only": False,
            "operations": [operation("PRAGMA foreign_keys=ON"), *replay],
        }
    )
    return cases


def sqlite_reference(source: Path, case: dict, directory: Path) -> list[dict]:
    path = directory / "reference.db"
    if path.exists():
        path.unlink()
    if not case["fresh"]:
        shutil.copyfile(source, path)
    connection = sqlite3.connect(
        f"file:{path}?mode={'ro' if case['read_only'] else 'rwc'}", uri=True, isolation_level=None
    )
    results = []
    try:
        for item in case["operations"]:
            params = [
                bytes(value["value"]) if value["type"] == "blob" else value.get("value")
                for value in item["params"]
            ]
            try:
                cursor = connection.execute(item["sql"], params)
                results.append(
                    {"rows": [[sql_value(value) for value in row] for row in cursor.fetchall()]}
                )
                cursor.close()
            except sqlite3.Error as error:
                category = "error"
                if isinstance(error, sqlite3.IntegrityError):
                    category = "constraint"
                elif getattr(error, "sqlite_errorcode", None) == sqlite3.SQLITE_READONLY:
                    category = "readonly"
                elif getattr(error, "sqlite_errorcode", None) in (
                    sqlite3.SQLITE_BUSY,
                    sqlite3.SQLITE_LOCKED,
                ):
                    category = "busy"
                results.append({"error": category})
    finally:
        connection.close()
    return results


async def run(probe: Path) -> dict:
    with tempfile.TemporaryDirectory(prefix="meshrik-turso-gate-") as temporary:
        directory = Path(temporary)
        source = directory / "v72.db"
        await create_sqlite_fixture(source)
        # Deterministic trigger clock; higher than wall clock, no timestamp masks.
        with sqlite3.connect(source) as connection:
            connection.execute("UPDATE virtual_companion_contact_clock SET revision=2000000000")
            connection.execute("CREATE TABLE fixture_free_pages(payload BLOB)")
            connection.execute("INSERT INTO fixture_free_pages VALUES(zeroblob(131072))")
            connection.execute("DROP TABLE fixture_free_pages")
            connection.commit()
            connection.execute("PRAGMA wal_checkpoint(TRUNCATE)").fetchall()
        connection.close()
        replay = await repository_operations(directory / "recording.db")
        # Diagnostic control ONLY. This rebuild is not an approved upgrade path:
        # #278 requires opening existing operator files without rebuilding them.
        control = directory / "control-no-autovacuum.db"
        shutil.copyfile(source, control)
        with sqlite3.connect(control) as connection:
            connection.execute("PRAGMA auto_vacuum=NONE")
            connection.execute("VACUUM")
            connection.execute("PRAGMA wal_checkpoint(TRUNCATE)").fetchall()
        connection.close()
        cases = [(source, case) for case in scenarios(replay)]
        for case in scenarios(replay):
            if case["name"].startswith(
                (
                    "contacts.",
                    "foreign_keys.",
                    "transactions.",
                    "indexes.",
                    "repository.",
                    "wal.",
                    "maintenance.foreign_key_check",
                )
            ):
                case = copy.deepcopy(case)
                case["name"] = "control_no_autovacuum." + case["name"]
                cases.append((control, case))
        rows = []
        for fixture, case in cases:
            fixture_bytes = list(fixture.read_bytes())
            reference = sqlite_reference(fixture, case, directory)
            try:
                process = subprocess.run(
                    [str(probe)],
                    input=json.dumps({"sqlite": fixture_bytes, "scenarios": [case]}),
                    text=True,
                    capture_output=True,
                    timeout=30,
                    check=False,
                )
                if process.returncode != 0:
                    result = {
                        "name": case["name"],
                        "status": "process_failure",
                        "statements": len(reference),
                    }
                else:
                    actual = json.loads(process.stdout)["results"][0]
                    if "open" in actual:
                        result = {
                            "name": case["name"],
                            "status": "open_failure",
                            "statements": len(reference),
                        }
                    else:
                        differences = [
                            index
                            for index, (expected, observed) in enumerate(
                                zip(reference, actual["results"], strict=True)
                            )
                            if first_difference(expected, observed)
                        ]
                        result = {
                            "name": case["name"],
                            "status": "different" if differences else "equivalent",
                            "statements": len(reference),
                            "different_operations": differences,
                            "native_errors": [
                                {"operation": index, "category": value["error"]}
                                for index, value in enumerate(actual["results"])
                                if "error" in value
                            ],
                        }
            except subprocess.TimeoutExpired:
                result = {"name": case["name"], "status": "timeout", "statements": len(reference)}
            except (KeyError, ValueError, TypeError):
                result = {
                    "name": case["name"],
                    "status": "invalid_probe_output",
                    "statements": len(reference),
                }
            rows.append(result)
        return {
            "engine": "turso",
            "version": "0.8.3",
            "default_features": False,
            "decision": "NO-GO"
            if any(row["status"] != "equivalent" for row in rows)
            else "NOT-YET-QUALIFIED",
            "scenarios": rows,
            "unverified": [
                "real_world_sanitized_copy",
                "historical_upgrade_bridge",
                "os_crash_and_power_loss",
                "arm64_workload",
                "busy_and_active_cursor_concurrency",
                "safe_maintenance_replacement",
                "full_application_query_corpus",
            ],
        }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--probe", type=Path, required=True)
    parser.add_argument("--report", type=Path)
    parser.add_argument(
        "--check-known",
        action="store_true",
        help="Check regression evidence; does not approve cutover",
    )
    args = parser.parse_args()
    report = asyncio.run(run(args.probe.resolve()))
    if args.report:
        write_json(args.report, report)
    print(f"Turso {report['version']}: {report['decision']}")
    for row in report["scenarios"]:
        print(f"  {row['name']}: {row['status']}")
    if args.check_known:
        difference = first_difference(json.loads(KNOWN.read_text()), report)
        if difference:
            print(f"Recorded compatibility evidence changed: {difference}")
        raise SystemExit(bool(difference))
    raise SystemExit(1)  # Full acceptance is never inferred from a partial matrix.
