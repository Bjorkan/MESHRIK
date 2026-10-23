# React hooks, Query and realtime guidance

Inherits [frontend/AGENTS.md](../../AGENTS.md). Hooks own
workflow state, cache reconciliation, effects and subscriptions.

- One Query-backed canonical contacts/channels cache: cancel
  stale list fetches before WS patches; reconnect reconciliation
  happens once, not for every event.
- `useConversationMessages` owns directional Infinite Query
  pages, pagination, pending ACK buffering, dedup, jump-target
  loading and cache restore. Preserve WS arrivals that occur
  during HTTP requests and cached pages outside fetched intervals.
- Unread state is server-owned; debounced exact-message read
  boundaries flush when conversations switch.
- `contact_resolved` is an identity migration across navigation,
  messages and unread state; not just a contact-list update.
- No automatic retry of non-idempotent sends after RF timeout.
- Packet observations live in `stores/rawPacketStore.ts` and
  are subscribed to only in consuming surfaces. Never lift
  `useRawPackets()` into App/AppShell/ConversationPane. Check
  `src/test/appPacketIsolation.test.tsx`.
- Pacer debounce may discard superseded search drafts, but not
  distinct RF observations, ACKs or protocol events.
- Test hook races, StrictMode mount/unmount, aborts and
  out-of-order WS/HTTP updates. See [frontend test guidance](../test/AGENTS.md).
