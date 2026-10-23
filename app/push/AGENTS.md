# Web Push backend guidance

Inherits [app/AGENTS.md](../AGENTS.md). Web Push is a
standalone subsystem, **not** a FanoutModule.

- Server manages VAPID, per-browser subscriptions and push
  delivery. Conversation filters in `app_settings.push_conversations`
  are **server-global**, shared by subscribed browsers, not
  independent per-device filters.
- Incoming message broadcasts reach `push_manager.dispatch_message()`
  independently of fanout. Expired/unregistered endpoints
  (HTTP 404/410) are deleted.
- Keep VAPID private keys, push endpoints and subscriptions
  out of logs and telemetry. HTTPS/outbound access are required
  for actual browser delivery.
- iOS/APNs may reject the default `.local` VAPID subject;
  operators should set a valid `MESHCORE_VAPID_SUBJECT`.
- Coordinate payload and click navigation changes with
  `frontend/public/sw.js` and `usePushSubscription`.
  Run `tests/test_push_send.py` for backend changes.
