# Backend pytest guidance

Inherits [root AGENTS.md](../AGENTS.md).

- Run focused suites with
  `PYTHONPATH=. uv run pytest tests/<file>.py -v`.
  For all tests use `PYTHONPATH=. uv run pytest tests/ -v`
  or the root quality gate when requested.
- Use fake radios, isolated DBs and deterministic clocks for
  radio/ACK/job tests. Fake transports are not hardware proof.
- Verify timeout/ambiguous send outcomes: a command may have
  transmitted even when HTTP returns 408, with a durable
  `send_status="unknown"` row. Avoid duplicate RF retries.
- Exercise read-state same-second ID tie-breakers, channel
  dedup paths and room sender-key distinctions.
- Router contract changes require matching OpenAPI regeneration/
  checks and API/frontend contract regression tests.
- Test migration compatibility without casually rewriting
  already deployed migrations.
- Test `id` vs `observation_id` and WebSocket reconnect flow
  for packet/stream changes.
- Detailed test inventory is in the
  [backend reference](../docs/agent-guides/backend-reference.md)
  when a historical file map is useful.
