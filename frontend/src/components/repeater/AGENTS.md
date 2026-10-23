# Repeater dashboard pane guidance

Inherits [frontend/AGENTS.md](../../../AGENTS.md).
Panes manage granular authenticated repeater operations.

- `RepeaterDashboard` and `useRepeaterDashboard` own the
  dashboard state. Authentication/guest state resets on
  conversation change.
- Repeater login performs **one HTTP call**. Backend may perform
  one flood retry for an unanswered directed login. Never add
  an additional client-side retry, especially on `LOGIN_FAILED`.
- Keep pane loading/error/retry semantics bounded. `Load All`
  fetches panes **serially** because radio commands share a
  single RF command lock; parallelization is not a free speedup.
- Neighbor map location is sourced from node-info. Region
  results distinguish authenticated CLI hierarchy and
  anonymous flood-allowed fallback (`source` field).
- Console history is ephemeral, not persisted; do not log
  credentials or replay unknown-outcome CLI commands.
- Run `repeaterDashboard.test.tsx`, `repeaterLogin.test.tsx`
  and affected backend repeater route tests.
