# Radio scheduler: response tracking and activity API (#40 / #41)

This continues the single-radio, in-memory scheduler introduced in #38/#39. **There is still one physical radio and one scheduled transport-command worker.** The existing `radio_operation()` lock remains the lower-level safety gate, including for unchanged legacy HTTP routes. This phase does **not** migrate message sending, login, settings, or periodic task producers (#42–#44); their existing HTTP responses and WebSocket events are preserved.

## Response correlation (internal, for producer migrations)

`app/services/radio_response_tracker.py` offers synchronous `reserve(job_id, kind=..., ...)`, a `PendingResponse.wait(timeout)` coroutine and `unsubscribe()` cleanup. Install a reservation **before** entering the transport command when the matching attributes are known; callers must not hold `radio_operation()` while waiting on RF. The worker returns `AWAITING_ACK` or `AWAITING_RESPONSE` after its short exclusive command. Multiple independent waits can coexist and a new command may start. Replies received before the worker switches to `awaiting_*` are buffered by the pending future and applied on the state transition. A terminal job cannot become successful again.

- DM ACK: reserve by the **expected ACK code and existing SQLite message ID**. Only the established `dm_ack_tracker` plus successful `increment_ack_and_broadcast` path can notify the new tracker. An unmatched early ACK continues to be buffered in `dm_ack_tracker`; on subsequent association with a message, the shared ACK path notifies the new tracker. Raw events do not independently assert delivery. All ACK code/message ID matching data remains private in memory.
- Repeater and room login: matching `LOGIN_SUCCESS` / `LOGIN_FAILED` subscriptions are scoped to the canonical target prefix, with exactly one target session at a time. The firmware lacks request identifiers. After a dispatched login (even one apparently successful), the same target is **fenced for the remainder of that radio generation**; this deliberately errs on the side of safety rather than misattributing a delayed or duplicate reply to a later login. Reconnect changes the generation and removes the fence. Before-dispatch cancellation does not fence the target. Other-target logins and ACK waits can coexist.
- CLI: a scoped `CONTACT_MSG_RECV` subscription filters by target and `txt_type=1`. While a CLI response session is pending, the scheduler blocks dispatch of unrelated scheduled commands because these responses share an ambiguous polling/reader channel. It does not block incoming packet processing. This applies to scheduler jobs; legacy producers remain unmigrated until #43, so do not interleave new CLI jobs with legacy CLI command sessions.
- Cancellation and deadlines: queued `unsubscribe()` cancels before dispatch; an `awaiting_*` unsubscribe stops waiting but **cannot retract radio traffic**. Timeout or disconnect after a possible send is `unknown`, not `failed` or `delivered`. Watchers and subscriptions are removed after terminal states, timeout, cancellation and reconnect. Maximum simultaneous response reservations: 128. Generation checks occur in incoming callbacks, not just during worker polling.

Do not log or serialize full targets, payloads, passwords, raw commands, ACK codes or message bodies. Do not build a second MeshCore instance or an independent polling command worker.

## Read-only job/activity REST API

All endpoints use the existing optional application-wide HTTP Basic Auth policy:

| Method | Endpoint | Contract |
| --- | --- | --- |
| `GET` | `/api/radio/jobs?status=&limit=&cursor=` | Recently changed jobs, newest first, `limit` 1–100, optional state filter, exclusive **update sequence** cursor, `has_more`, `next_cursor`, `snapshot_sequence`, radio/command status |
| `GET` | `/api/radio/jobs/{job_id}` | Full sanitized state, stage, version, result and timestamps, or 404 |
| `POST` | `/api/radio/jobs/{job_id}/cancel` | Idempotent typed result. Queued: `cancelled_before_dispatch`. Executing: `requested` (cooperative only). Awaiting: `stop_waiting` (not an RF undo). Terminal: `unchanged`. Missing: 404 |
| `GET` | `/api/radio/activity?cursor=&limit=` | Bounded recent **inbound/connection** event classifications, oldest first on cursor replay, `limit` 1–100, monotonic sequences and `gap` if retained history was overrun |

Activity is a bounded ring of at most 512 sanitized classifications, not a raw-packet or chat-message store. `source` distinguishes raw RF log, MeshCore event and radio lifecycle. Job IDs appear in activity records only for reliable local correlations. `radio_status` describes connection/initialization; `command_status` describes the scheduled command permit (`legacy_busy` is distinct); `physical_rf_state: "unavailable"` explicitly avoids claiming physical transmit/receive/listen state. A running command is **not** proof of RF TX. Connection state must not be inferred from an `awaiting_*` job.

The list cursor is not a stable database transaction: versions can advance while fetching pages. On reconnect or uncertain gaps, **refetch the snapshot** rather than treating previously cached pages as a comprehensive history. A process restart loses the in-memory jobs/activity (but not the existing SQLite message history), so clients should discard stale job state after reconnect.

## WebSocket contract and future 202 migration

Existing `/api/ws` now also broadcasts typed `radio_job` (sanitized `RadioJobSnapshot`, including `id`/`version`/`sequence`) and `radio_activity` (`RadioActivityRecord`, including `sequence` and no packet data). Existing message/health events are unchanged. Client consumers should drop duplicate/out-of-order job deltas by **job ID + version**, activity duplicates by sequence, and refresh both GET snapshots on reconnect. `frontend/src/hooks/useRadioJobFeed.ts` uses React Query for this reconciliation and exposes callbacks for the existing shared `useWebSocket` connection; #45 will wire these into the dedicated Radio Activity page without opening another socket.

**There is intentionally no arbitrary command POST endpoint** (`POST /api/radio/jobs` is not supported). Future individually validated enqueue endpoints in #42–#44 may use `202 Accepted` with `RadioJobAccepted { job_id, state }`; a 202 means *accepted into memory*, not successfully transmitted or acknowledged. Keep existing routes synchronous until an explicit opt-in/compatible migration is implemented. Never enable automatic retries on ambiguous transmissions.

## Verification

- `uv run pytest tests/test_radio_response_tracker.py tests/test_radio_jobs_api.py tests/test_radio_job_scheduler.py`
- `uv run ruff check app tests` / `uv run ruff format --check app tests` / `uv run pyright app`
- `uv run python scripts/build/dump_api_specs.py frontend/openapi --openapi-only` then frontend `npm run api:types`, `npm run lint`, `npm run format:check`, `npm run test:run`, `npm run build`
- Follow repo `AGENTS.md` for the complete quality gate. API schema drift checks compare generated artifacts against **committed** files; while working with intentional, uncommitted API changes, verify generation determinism rather than requiring `git diff --exit-code` against the old commit.

Hardware-only verification is still required for real repeater/room responses, CLI drain/poll behavior, BLE/TCP/serial reconnect timing and physical RF-state research (#47). No CI test should send real RF traffic.
