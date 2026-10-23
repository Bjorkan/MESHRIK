# Fanout integration guidance

Inherits [app/AGENTS.md](../AGENTS.md). This area owns MQTT,
Home Assistant MQTT discovery, community feeds, Python bots,
webhooks, Apprise, SQS and map upload.

The existing [full fanout architecture notes](AGENTS_fanout.md)
contain module-specific detail. Read them **when changing fanout**,
not during unrelated API or frontend work. This short file makes
the local scope automatically discoverable without eagerly
loading that large specialized reference.

- Keep `FanoutModule`, manager lifecycle, event scope matching,
  `fanout_configs` persistence and CRUD endpoints consistent.
- `broadcast_event()` feeds WebSocket and optional fanout;
  guard against duplicate/unscoped publishing and leakage of
  private message content, tokens or MQTT credentials.
- Bot `exec()` with full builtins is an **intentional** trusted-
  network power-user feature. Preserve warnings and
  `MESHCORE_DISABLE_BOTS=true`, including HTTP config rejection.
- Community MQTT compatibility and route path serialization
  depend on variable byte width; inspect wire contracts before
  changing topics, packet metadata or fanout scope.
- Run `tests/test_fanout.py`, `tests/test_fanout_integration.py`
  and relevant module-specific tests for changes.
