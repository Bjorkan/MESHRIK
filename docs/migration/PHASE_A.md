# Rust/Turso Phase A evidence

The reference is `68647d0fa2439a6f47dbb53e3614df9f6aaf013e` (3.17.1).
Capture checkout `075064e8d0cc428c39ff7607424e91ef93b3ce0e` adds only documentation.
The Python runtime remains authoritative and the default throughout this stack.
Nothing here authorizes production radio or database access from Rust.

## Stack order

Create and validate each PR before starting its successor, with the bottom on
`main` and every following PR based on the preceding branch:

1. #276 frozen Python contracts and hardware-free oracle.
2. #277 isolated Rust service foundation.
3. #296 pinned native Turso feasibility probe (blocking storage gate).
4. #278 fresh native storage initialization and legacy discard, after the fresh-storage gate.
5. #279 contacts/channels/settings/fanout repositories.
6. #280 messages/packets/cursors/stats/push repositories.

This is a review sequence, not a claim that any issue is already complete.
Do not merge or enable the migration on the basis of partial fixture coverage.

Current stack: [A01 / #303](https://github.com/Bjorkan/MESHRIK/pull/303) →
[A02 / #304](https://github.com/Bjorkan/MESHRIK/pull/304) → A03 / #296 evidence.
The native GitHub stack is #305.
The [storage-reset decision](STORAGE_RESET_DECISION.md), explicitly requested
by the maintainer on 2026-11-15 and recorded in every migration issue, permits
discarding legacy SQLite without backup or import. The historical legacy-file
NO-GO no longer blocks a fresh `auto_vacuum=NONE` database. See the
[fresh-native qualification](TURSO_FEASIBILITY.md) before the storage/repository
layers. The HTTP backend remains fixture-only until its later release gates.

## Rust foundation (Linux fixture mode)

```sh
MESHRIK_RUST_FIXTURE=1 MESHRIK_RUST_FIXTURE_DIR=/tmp/meshrik-rust-fixture \
  cargo run --locked -p meshrik-backend
bash scripts/quality/rust.sh
```

Use the pinned Rust toolchain and a built frontend (`frontend/dist`, or explicit
`MESHRIK_RUST_FRONTEND_DIR`). The listener defaults to `127.0.0.1:8001`;
`MESHRIK_RUST_LISTEN` accepts only loopback addresses. Fixture mode rejects any
configured physical transport. It initializes/reopens native storage only at
the explicitly supplied fixture directory, under Python's `.radio-owner.lock`
protocol for its entire lifetime. See [native storage](NATIVE_STORAGE.md) for
the approved legacy discard boundary and native preservation/recovery rules.
SIGINT/SIGTERM gracefully stop HTTP before releasing the lease.
No installer, container, Python startup or production default selects Rust.

Root/deep links, assets, service worker, PWA manifest, validated HA ingress base,
Basic auth and CORS use the same public conventions. `/docs` and `/openapi.json`
describe only the fixture health endpoint; `/api/health` returns 503 with
explicit unavailable resources (`database_open=true` when initialized) and
other API/WS operations return 501. This is
a bootable foundation, not a production frontend/API or integration readiness
claim. #289/#290 own full REST/WS implementation and differential acceptance.

## Frozen oracle

`tests/fixtures/migration/python-v72` contains REST/OpenAPI (including errors,
pagination and 202 jobs), every typed WebSocket event schema, resulting v72
schema/index/trigger DDL, representative empty-read and validation responses,
and a mechanical inventory of every app module/async function, API operation,
environment and persisted setting. No operator data is read. HTTP capture
does not run application lifespan; all repository DB handles are replaced by
one disposable file. Health/radio-backed routes are deliberately excluded.
Only request IDs are omitted from HTTP comparison; JSON values and array order
are compared exactly, including legacy defects. No secret/timestamp wildcarding.

`storage-replay.json` records synthetic substring/escaped LIKE/user/channel
search, historical and same-second pagination/unreads, interrupted pending-send
recovery (including repeat recovery), room-sender fallback and raw-packet repeats
with a changed path. Output contains IDs/statuses, never packet payloads or real
identities. Synthetic inputs are source-controlled labels and bytes.

Reproduce into a temporary directory, then review differences manually:

```sh
PYTHONPATH=. uv run python scripts/migration/capture_baseline.py /tmp/python-baseline
PYTHONPATH=. uv run pytest tests/test_migration_baseline.py -v
```

The same frozen HTTP cases can test an independently started disposable Rust
fixture server with `--compare-http http://127.0.0.1:PORT`. Comparison reports
route and field/index, never differing payload values. A scaffold returning 501
must fail comparison, rather than claim implemented parity.

`create_sqlite_fixture` builds and checkpoints a new synthetic v72 SQLite file,
refusing existing paths. Turso probes operate on copies after SQLite closes.
Never point fixtures at `data/`, operator backups, or a running backend DB.

## Evidence matrix and remaining gates

| Area | Python evidence | Required Rust evidence |
| --- | --- | --- |
| Every API operation, setting, integration and task | frozen inventory, OpenAPI | workstreams #277–#295; inventory presence alone is not coverage |
| WS schema, initial health/pong, delivery/reconnect order | frozen schema; `test_websocket.py`, `test_websocket_route.py` | #290 ordered replay/failure comparison |
| Framing/v13/v14 | `test_companion_protocol_118.py`, `test_virtual_companion_protocol_contract.py` | #281, #294 binary golden comparison |
| Ambiguous TX, durable ingress, ACK recovery | `test_patch_140.py`, `test_send_messages.py`, `test_patch_149.py`, `test_patch_153.py` | #284/#285 crash/timeout comparison |
| Search, same-second IDs/read-state, raw identity | `test_repository.py`, `test_messages_search.py`, `test_raw_packet_identity_migration.py`, `test_property_invariants.py` | #280 query-by-query comparison |
| Stats windows/denominators | repository/statistics tests | #280 frozen-clock comparison, #297 measured replay latency |
| Trigger/tombstone, migration/rollback and maintenance | v72 DDL; migration/VC tests | #296 actual pinned-engine execution, crash and clean-stop rollback |
| Commit → WS/fanout ordering | message/fanout/packet pipeline tests | #299 post-commit replay; no raw secrets in events |

The first layer freezes contracts and provides the harness seam. It does not
complete #276's Turso round-trip, full behavior replay or performance acceptance.
Those remain explicit gates, not mock successes or inferred hardware parity.

## Known-bug register

Reviewed issue text on 2026-11-15. Open epic checkboxes are not evidence a bug
still reproduces; code/tests at the reference revision decide observed behavior.

| Owner | Baseline concern | Migration policy |
| --- | --- | --- |
| #156 | RX loss, wrong-channel attribution, TX ambiguity, ACK/queue races | preserve current regression tests; P0 unresolved behavior blocks release |
| #168 | v13/v14 CLI/datagram classification and capability gaps | typed CLI is not ordinary chat; pin SDK/firmware fixtures |
| #37 | one worker, bounded scheduling, independent response waits | no second command owner; timeout is unknown, never automatic replay |
| #224/#256 | Virtual Companion compatibility and release work | preserve opt-in, per-client cursors, shared identity and denied key export |
| #146 | WS broadcast ordering and reconnect resync | compare ordered delivery and snapshot recovery, not only JSON schemas |
| #159 | worker quarantine after read-only timeout | generation/quarantine recovery tests; do not normalize stuck state away |
| #296 | Turso SQL/PRAGMA/file-format compatibility unproven | no production Turso writes or repository implementation before passing |

Observed baseline deviation: `MessageRepository.create`'s no-wire-ID fallback
lookup omits `sender_key`, so two room senders with the same body/second collapse
before the sender-aware unique index can distinguish them. The frozen
`room_fallback.second = null` captures this under #156/#145; this is not approved
behavior to silently fix or normalize in the migration.

Any observed discrepancy is recorded against its existing owner, with a focused
reproducer; the migration must not silently repair unrelated reference behavior.
