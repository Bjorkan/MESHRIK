# API route and handler guidance

Inherits [app/AGENTS.md](../AGENTS.md). FastAPI routers are
request/response boundaries, not parallel workflow owners.

- Keep typed request/response contracts and `/api` prefix aligned
  with `frontend/openapi/openapi.json` and generated TypeScript
  contracts. Check both sides on a breaking API/WS change.
- Validate input at the boundary; delegate persistence to
  repositories and radio actions to services.
- Distinguish validation/denial (4xx), ambiguous RF response
  timeout (408) and server failure (5xx). Do not retry
  non-idempotent radio commands after an HTTP timeout.
- Protect credentials, private keys and raw messages in errors
  and instrumentation. Maintain optional Basic auth and explicit
  operator-controlled trusted-network behavior.
- Repeater/room login shares `routers/server_control.py`
  logic: only a timed-out non-flood directed login may escalate
  to one flood retry; explicit `LOGIN_FAILED` must not.
- Update focused router tests and regenerated OpenAPI contracts
  when altering endpoint behavior. Deeper historical endpoint
  inventory: [backend reference](../../docs/agent-guides/backend-reference.md).
