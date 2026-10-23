# Backend agent guidance — app/

Inherits [root guidance](../AGENTS.md). FastAPI handlers, services,
repositories, radio, realtime transport and integrations live here.
Consult deeper guides when editing [routers](routers/AGENTS.md),
[services](services/AGENTS.md), [repository](repository/AGENTS.md),
[fanout](fanout/AGENTS.md) or [push](push/AGENTS.md).

## Architecture and invariants

- Routers translate and validate HTTP requests. Services orchestrate
  workflows and the radio; repositories own persistence/transactions.
- Serialize radio commands through the existing `radio_runtime.radio_operation()`
  / RadioManager lock. Avoid parallel send paths or duplicate command owners.
- RF timeout can represent an **unknown outcome**, not an unsent message.
  Do not automatically replay non-idempotent commands.
- `full` is the only supported startup policy; sensitive key export,
  writes, advert/drain and destructive contact/channel offload are opt-in.
- Packet `path_len` means hop count, not bytes. `path_hash_mode`
  0/1/2 means 1/2/3 bytes per hop. ACKs confirm delivery, not new routes.
- REST provides actions/history, WebSocket live updates; preserve
  deduplication when raw packet and higher-level event paths overlap.

## Safety, tests and references

- Broad CORS, optional Basic auth and unsandboxed operator Python bots
  are deliberate trusted-network choices. Preserve operator warnings,
  `MESHCORE_DISABLE_BOTS` and private-key-in-memory semantics.
- Don't serialize credentials, messages or raw RF payloads in scheduler
  diagnostics, errors or logs. Respect generation fences after disconnects.
- Run focused backend tests: `PYTHONPATH=. uv run pytest tests/ -v`;
  see [test guidance](../tests/AGENTS.md).
- The [detailed backend reference](../docs/agent-guides/backend-reference.md)
  preserves protocol, endpoint, scheduler and test rationale; open only
  sections relevant to the task. Code/tests are authoritative.
