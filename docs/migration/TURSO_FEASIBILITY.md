# Native Turso qualification

The [maintainer's storage-reset decision](STORAGE_RESET_DECISION.md) replaces
the legacy-file preservation requirement. Rust starts with fresh native
storage and may discard old SQLite without saving or importing it. Initialized
Turso databases must survive subsequent restarts. All #275–#302 issues carry
this decision.

## Fresh configuration

Pinned native `turso = =0.8.3`, `default-features = false`, Cargo.lock and Rust
1.99.1. Use local `Builder::new_local`, normal WAL, foreign keys and
`auto_vacuum=NONE`. No experimental auto-vacuum/vacuum, MVCC, FTS, CDC,
encryption, replication or cloud builder is enabled.

```sh
cargo build --locked -p meshrik-turso-probe
PYTHONPATH=. uv run python scripts/migration/turso_gate.py \
  --probe target/debug/meshrik-turso-probe --fresh-native
bash scripts/quality/turso_gate.sh
```

With `CARGO_TARGET_DIR` set, use that directory's `debug/` binary. The quality
script checks both the historical legacy NO-GO and the committed fresh-native
evidence. It never rewrites the evidence automatically.

Fresh tests pass SQL/DDL and synthetic values into a native process that
creates its own private temporary file. No operator database or legacy file
bytes are imported. The SQLite reference independently creates the same logical
schema/defaults. Each scenario is bounded by a subprocess timeout. Readonly
tests reopen bytes created and cleanly checkpointed by a preceding native
process. SQLite checks exported native files only after the native owner exits.

The fresh matrix covers 24 scenarios, including schema/defaults, WAL/settings,
triggers/tombstones, FK enforcement/cascades, search/cursors, send recovery,
the 54 recorded repository operations, page growth/deletion, a native schema
upgrade, readonly open and checkpoint/reopen integrity. Rust regression tests
add native AUTOINCREMENT restart/deletion, unfinished-writer busy behavior,
read-cursor release, BLOB/NULL fidelity and failed-checkpoint export rejection.

## Explicit compatibility policies

- **PRAGMA setters:** Turso's `execute` API can reject row-returning pragmas.
  Use `query`, fully drain/close the rows, and then inspect the getter. The
  fixture mode `drain_rows` explicitly consumes setter metadata; application
  result fields and row ordering remain exact comparisons.
- **Schema introspection:** fresh Turso adds engine-private AUTOINCREMENT
  sequence tables. Compare every application table/index/trigger while
  excluding only the explicit `__turso_internal_seq_` prefix. Separate process
  restart/deletion tests verify the native counters rather than assuming
  SQLite's private `sqlite_sequence` implementation.
- **Foreign-key integrity:** native `PRAGMA foreign_key_check` misses an orphan.
  The tested replacement enumerates FK/PK metadata and uses anti-joins. It
  covers the actual app schema plus composite keys, implied primary keys,
  parent collation and partially NULL child keys. It reports real violations
  rather than accepting an empty unsupported-pragma result.
- **Maintenance:** in-place `VACUUM` is unsupported with the selected flags.
  The matrix requires an explicit error; no successful compaction claim is
  permitted. The storage/API layer must expose that limitation and supported
  checkpoint/recovery operations. Incremental vacuum is unnecessary with the
  fresh `NONE` configuration.
- **Text:** no legacy invalid-UTF-8 TEXT is imported. Application text stays
  validated UTF-8; binary packet data stays BLOB. No lossy BLOB→TEXT identity
  conversion is used.

`FRESH-FIXTURE-CORRECTNESS-PASS` permits the next isolated implementation layer;
it is not production cutover approval or closure of every #296 release check.
Full repository query parity, fault-injected process/OS crashes, native recovery
and concurrent lifecycle tests must grow with the adapter/repository ports.
ARM64, hardware and final production acceptance remain explicit release gates.

## Historical evidence

PR #306 and `tests/fixtures/migration/turso-0.8.3.json` reproduce the original
32-scenario / 308-operation legacy-file NO-GO: v72 incremental-auto-vacuum
files become read-only under the default builder. A diagnostic rebuilt copy
without auto-vacuum isolates that failure. This remains useful regression
evidence, but legacy-file compatibility is no longer a migration prerequisite.

Before the revised decision, a test-only 0.9.0-pre.5 investigation showed that
explicit experimental auto-vacuum could pass small writes while growth and
SQLite reopen/integrity checks still failed. That candidate and its flags are
not adopted. The fresh-storage implementation uses the stable pin above.

Reports contain scenario names, statement indices and error categories, never
SQL strings, bound values, real identities or packet payloads. No radio or
operator database participates in these tests.
