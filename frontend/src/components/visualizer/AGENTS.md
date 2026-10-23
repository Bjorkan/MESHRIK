# 3D packet visualizer guidance

Inherits [frontend/AGENTS.md](../../../AGENTS.md).

Read the detailed [packet visualizer architecture guide](AGENTS_packet_visualizer.md)
**for work in this directory**, not for unrelated frontend tasks.
This new scoped file makes the specialized reference discoverable.

- `PacketVisualizer3D` delegates simulation, scene lifecycle
  and controls to visualizer modules. Preserve persistent
  Three.js geometry, in-place buffers and bounded render work.
- Prefer decoder `messageHash` (path-insensitive) for repeat
  aggregation, with fallback for malformed packet data.
- `observation_id` identifies an RF arrival; `id` is the
  durable raw-packet storage identity. Multiple observations
  may have distinct hop paths without a new DB packet row.
- Advert-path identity hints support topology disambiguation,
  **never** outbound DM route selection.
- Subscribe to raw packets through narrow Store selectors in
  a consuming view, not in ancestors of MessageList.
- Check multibyte decoder compatibility and packet isolation
  tests when changing ingestion or visualization.
