# MESHRIK — repository-wide agent guidance

MESHRIK is a FastAPI + React web interface for MeshCore radios (Serial, TCP, BLE).
This short guide applies repo-wide. Directory-local `AGENTS.md` files add
instructions for their subtrees. The closest applicable instruction wins on
conflict; explicit user requests take priority. Clients differ in when nested
guides are discovered, so open a subtree's guide when entering that subtree,
not all guides at startup.

## Development workflow

- When asked to **run all tests**, **prepare a commit**, or finish a major
  code change, run `./scripts/quality/all_quality.sh`. It runs autofixers
  first, then checks/tests/build; inspect any resulting formatting edits.
- Docs-only changes do not need the entire quality gate. For minor cosmetic
  changes use focused checks unless the user requests the full gate.
- Add relevant regression tests when changing behavior. Never claim
  validation was performed without actually running it.
- Prefer cohesive, locally readable code over thin forwarding modules,
  duplicate state ownership and speculative abstraction.
- Do not casually change REST/WebSocket contracts, radio semantics or
  protocol identifiers.

## Where to work

| Area | Scoped guide | Typical checks |
| --- | --- | --- |
| FastAPI / radio / SQLite | [app/AGENTS.md](app/AGENTS.md) | `PYTHONPATH=. uv run pytest tests/ -v` |
| React frontend | [frontend/AGENTS.md](frontend/AGENTS.md) | `cd frontend && npm run test:run` |
| Backend tests | [tests/AGENTS.md](tests/AGENTS.md) | focused `pytest` |
| Build, setup, release | [scripts/AGENTS.md](scripts/AGENTS.md) | validate side effects |
| Deep technical history | [Reference index](docs/agent-guides/README.md) | read on demand only |

Backend startup: `uv sync && uv run uvicorn app.main:app --reload`.
Frontend development: `cd frontend && npm ci && npm run dev`.
Production FastAPI serves the built frontend; API routes use `/api`.

## Load-bearing product invariants

- Primary features are correct DM/channel sending and receiving, history,
  ACK/repeat/path tracking, historical decryption and reconnection.
- A radio timeout is **not proof of failed transmission**. Do not
  automatically retry non-idempotent sends or commands.
- Raw-packet `id` is durable storage identity; `observation_id` is
  realtime per-arrival identity and can distinguish repeats with new paths.
- Intentional trusted-network security posture: broadly permissive CORS,
  no user accounts, optional coarse Basic auth and powerful Python bots.
  Do not silently redesign those documented decisions. Preserve their
  safety warnings, `MESHCORE_DISABLE_BOTS` and private-key safeguards;
  still investigate newly introduced security vulnerabilities.
- Keep private keys, passwords, message bodies and packet payloads out of
  new diagnostics/telemetry.

## Maintaining this guidance

Place domain rules at the nearest directory that **owns the invariant**;
avoid repeating parent guidance. Keep root instructions short. Detailed
historic notes are preserved in [docs/agent-guides](docs/agent-guides/README.md)
for selective reading, not eager context loading. When behavior changes,
update the relevant scoped guide and reconcile affected long-form references.
