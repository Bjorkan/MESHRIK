# Backend service and radio workflow guidance

Inherits [app/AGENTS.md](../AGENTS.md). Services own orchestration
and workflow invariants, not HTTP handlers or database schemas.

- Use the single `radio_runtime.radio_operation()` / RadioManager
  command lock. Never introduce an independent MeshCore instance,
  overlapping radio sends, or a second execution permit.
- Distinguish a locally accepted command, confirmed RF delivery,
  unknown outcome, explicit refusal and timeout. Do not replay
  uncertain transmissions automatically.
- Outgoing DMs retry only if initial `MSG_SENT` includes an expected
  ACK code. Respect radio `suggested_timeout`. Earlier attempts use
  `override > learned direct > flood`; final retry forces flood.
  First ACK is terminal; clear pending sibling ACK codes.
- `dm_ingest.py` owns fallback DM reconciliation; host ACK events
  and ACKs decoded from RF must both be handled. ACKs never update
  contact routes. Advert paths are analytics-only, not send routes.
- Server login uses effective contact route, then tries flood
  **exactly once only when the first non-flood attempt gets no
  response**. Do not retry `LOGIN_FAILED` or local send errors;
  do not re-stage the old route between reset and flood retry.
- Channel sends use firmware-reported capacity and session LRU.
  TCP sends force `set_channel` before transmission. Startup
  must not clear radio slots without explicit opt-in.
- `radio_jobs.py`/`radio_job_scheduler.py`/
  `radio_job_worker.py` form a **scheduler foundation**, not an
  implicit migration of legacy command producers. Command permit
  excludes RF response waits; connection generations fence stale
  replies; timeouts can quarantine a worker. SQLite remains the
  durable outgoing-message source of truth.
- Write fake-radio / fake-clock regression tests for sensitive
  changes. See [backend deep reference](../../docs/agent-guides/backend-reference.md)
  only for detailed protocol rationale when needed.
