# Native Turso feasibility: NO-GO

Status on 2026-11-15, for #296 / #275: **do not implement or enable the
production storage adapter or repositories (#278–#280) on this engine/config.**
The test-only probe does not link Turso into the fixture HTTP backend. Python
remains the production backend. No operator database has been inspected or
modified, no radio opened, and no cloud/sync builder used.

## Engine and reproducibility

Pinned native Rust `turso = =0.8.3`, `default-features = false`, plus Cargo.lock.
The engine/SDK/parser crates resolve to 0.8.3. Rust toolchain is 1.99.1.
This is embedded `Builder::new_local` with the default I/O backend and normal
WAL. No experimental builder flags, MVCC, FTS, CDC, encryption, materialized
views or replication are enabled. Disabling the public crate's default
features does not remove every transitive SDK dependency; it does keep the
probe's sync feature and remote builder unused.

Measured locally on Linux x86_64, Python 3.13.14 / SQLite 3.53.1. Hardware,
ARM64, realistic latency and power-loss qualification are not claimed.

```sh
cargo build --locked -p meshrik-turso-probe
PYTHONPATH=. uv run python scripts/migration/turso_gate.py \
  --probe target/debug/meshrik-turso-probe --report /tmp/turso-report.json
# exits 1: NO-GO, intentionally

bash scripts/quality/turso_gate.sh
# checks the committed evidence; success means the known NO-GO is reproducible,
# never permission to adopt the engine or a passing cutover gate
```

With `CARGO_TARGET_DIR` set, use that directory's `debug/` binary. CI and All
Quality run `--check-known` and fail if the recorded evidence changes. Review
changed evidence rather than automatically refreshing it.

The Python generator runs all 72 migrations into a disposable SQLite file,
adds only synthetic fixture setup, commits, checkpoints and closes it. The
probe receives bytes on stdin, creates private temporary copies and accepts
no operator DB path. Every scenario runs in a separate subprocess with a
30-second timeout. SQLite and Turso never access the same file concurrently.
Reports contain scenario names, statement indices and error categories, not
SQL strings, bound values, node identities or packet payloads.

## Blocking result: existing v72 databases become read-only

MESHRIK enables `auto_vacuum=INCREMENTAL`, including migration 20. A normal
generated v72 file therefore reports mode 2. Native Turso 0.8.3 opens and reads
its schema, but its default engine changes that handle to **read-only** because
the file has auto-vacuum metadata and experimental auto-vacuum is not enabled.
Simple updates and inserts return `readonly`, including durable send intent,
RX journaling, contact trigger clocks, ACK correlations and reservations.

This is a file-compatibility blocker, not evidence that all those SQL queries
or triggers are independently broken. The pinned engine's source confirms the
read-only switch in [core/database.rs](https://github.com/tursodatabase/turso/blob/607bff9fd0e547a25a97b3bf06e83bcc5d99d53c/core/database.rs#L1935).
The public native builder does not expose an auto-vacuum flag, and the pinned
core also rejects incremental mode in relevant write/vacuum paths. Enabling an
experimental option is not a demonstrated fix.

For diagnosis **only**, the harness makes another disposable SQLite copy,
sets `auto_vacuum=NONE`, runs SQLite `VACUUM`, checkpoints and closes it before
passing bytes to Turso. On this control file, trigger revisions/tombstones,
UPSERT/rollback, FK cascades, send recovery, savepoints, partial/expression
indexes and all 54 recorded repository operations match SQLite. This isolates
the default-file blocker. It does **not** authorize rebuilding operator files
or satisfy #278's requirement to open existing files without rebuilding them.

Required resolution in #275/#296: a verified upstream native API/engine fix
for existing incremental-vacuum files, or a separately recorded and reviewed
change to the migration strategy. Any proposed conversion must preserve IDs,
all rows/BLOBs, triggers/indexes, backup/restore and clean-stop SQLite rollback,
and must be tested before the gate can pass. No production conversion tool or
automatic fallback is introduced here.

## Capability evidence

Committed matrix: `tests/fixtures/migration/turso-0.8.3.json`, 32 isolated
scenarios / 308 statement executions per engine. Raw differences are preserved;
the report does not silently normalize them into success.

| Capability | Measured result | Required action |
| --- | --- | --- |
| Existing v72 schema/IDs and fresh v72 DDL | Schema reads and 63 fresh-schema operations match | Not proof that existing files can be written |
| WAL, synchronous NORMAL, cache size, temp store, FK toggles | Tested getter/setter cases match | Verify complete runtime locking/durability before adoption |
| busy_timeout | Setter returns different row metadata; getter matches | Document/test adapter handling; not the write blocker |
| Existing mode-2 files | Writes fail as read-only | Blocking engine/API or approved strategy resolution |
| `auto_vacuum=INCREMENTAL` setter | Error without experimental support | No silent startup success or experimental enablement |
| `incremental_vacuum` with freed pages | Does not reproduce SQLite reclamation | Implement and verify an explicit safe maintenance replacement |
| In-place `VACUUM` | Error with default builder | Same replacement requirement; no false successful maintenance response |
| `foreign_key_check` with an actual orphan | Different; on writable control it misses SQLite's violation result | Alternative explicit integrity validation must be implemented/tested |
| Checkpoint | Default-file result differs; control matches | Checkpoint sidecars, restart and SQLite rollback still unqualified |
| Read-only dry-run | Version read and rejected update match | Must remain separate from a write-capable adoption claim |
| Contact triggers, FK enforcement/cascades, durable pending→unknown recovery | Equivalent on writable diagnostic control, blocked on normal file | Cannot adopt until file compatibility is resolved |
| Window function, JSON, case-insensitive LIKE, binary BLOB | Representative query values match | Full query/traffic corpus still required |
| Invalid UTF-8 TEXT | SQLite decoding error versus Turso replacement text | Explicit byte/text policy required; raw BLOB identity must stay exact |

Empty databases can make unsupported maintenance look successful. The suite
therefore creates freed pages and an FK orphan, rather than accepting empty
`incremental_vacuum` / `foreign_key_check` results as implementation proof.

## Remaining acceptance gates

The NO-GO is independently sufficient to block #278–#280. Other #296 acceptance
criteria also remain unverified: historical-version upgrade bridge and
unknown-future/corrupt-version policy, sanitized real-world database copy,
OS crash/power-loss durability, busy/active-cursor cancellation and concurrent
connections, backup/restore and clean-stop downgrade, full application SQL
corpus, and ARM64 workload. No partial matrix, mock or diagnostic control
clears those gates. #276's corresponding cross-backend and performance
acceptance remains open.

Optional #297–#302 optimizations are neither enabled nor blockers merely for
being untested. The current blocker is correctness of normal local files and
maintenance, not lack of an experimental feature.
