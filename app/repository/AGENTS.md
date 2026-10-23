# SQLite repository and persistence guidance

Inherits [app/AGENTS.md](../AGENTS.md). Repositories own
transactions, indexes, deduplication and cursor semantics.

- Raw-packet storage `id` is based on canonical packet payload
  identity (ordinary path bytes excluded); WebSocket
  `observation_id` is unique per RF arrival. Repeats may merge
  into one durable row while retaining separate live observations.
- Channel-message dedup identity includes `type`,
  `conversation_key`, `text`, `COALESCE(sender_timestamp,0)`
  for CHAN. Incoming PRIV also adds `COALESCE(sender_key,'')`
  to distinguish room senders sharing a second and body.
- On a repeated observation, merge path information and increment
  ACK/echo count only for **outgoing channel messages**.
- Read/unread cursor is server-owned and monotonic:
  `(last_read_at, last_read_message_id)`. Same-second ties and
  historically decrypted old rows matter. First-unread ID cannot
  be derived by a bare `MIN(id)` or ambiguous `MIN(received_at)`.
- Keep contact route path, hop count and path-hash width together.
  Advertisement path history is for visualizer/analytics only;
  it does not become the outbound DM route.
- Write migration and repository regression tests for schema or
  index changes. Avoid secret leakage in queries/errors/logs.
  Consult [backend reference](../../docs/agent-guides/backend-reference.md)
  for more historical detail only if relevant.
