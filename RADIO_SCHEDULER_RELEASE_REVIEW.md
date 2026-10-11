# Final radio scheduler release review checklist

**Scope:** #37–#47; see the actual issue bodies for source-of-truth criteria.
This is a review worksheet, **not** a claim that all items are complete.

## Automated acceptance

- [ ] `./scripts/quality/all_quality.sh` passes (backend pytest/Ruff/Pyright,
      frontend TypeScript/Vitest/ESLint/Prettier/build, OpenAPI regen).
- [ ] Scheduler admits only one command at a time; 20 concurrent producers,
      FIFO/priority aging, coalesced singleton maintenance, capacity/TTL and
      disconnect fencing covered by deterministic fake transport tests.
- [ ] All normal production radio operations enter `radio_runtime`/the single
      worker. Explicitly audit any direct `RadioManager.radio_operation` access
      outside the worker/lifecycle setup.
- [ ] DM ACK and channel echo match durable SQLite identity. Uncertain send
      cannot be treated as failed, auto-replayed or delivered. No duplicate
      outgoing rows across same-key opt-in HTTP retries while job retained.
- [ ] Concurrent DM ACK + login + unrelated command works when correlation
      is safe; same-target login and unsafe CLI requests stay exclusive.
- [ ] Login late reply/flood fallback, cancellation, worker timeout/quarantine,
      restart, reconnect and rollback behave correctly and fail closed.
- [ ] REST 202 contracts, legacy HTTP compatibility, queued cancellation,
      stop-waiting and WS gap/reconnect dedup tests are green.
- [ ] Security audit: public job/activity snapshots and logs never contain
      credentials, raw message text, private key or full node addresses.

## Hardware smoke (explicit operator authorization required)

Use `HARDWARE_SMOKE_TEST.md`. Start with
`MESHCORE_PASSIVE_STARTUP=true` and `MESHCORE_DISABLE_BOTS=true`,
**a separate test SQLite DB** and **one uvicorn worker**. Verify the antenna,
frequency/region, radio identity and authorized endpoints before TX.

- [ ] Authorized Companion TCP host/port passive connect / GET health and job
      snapshots: no clock set, flood changes, advertisement or reboot.
- [ ] One controlled test-channel message. Compare command admission,
      SQLite message/packet row, observed echo, WS activity and any repeat.
      A `202` receipt is not a delivery confirmation.
- [ ] One controlled DM to an authorized test recipient **only if contact is valid and available**.
      Observe durable ACK association, no duplicate retry, and Stop waiting.
- [ ] Authorized read-only repeater status/guest login; optionally
      request **one** advert if explicitly confirmed safe. Never modify ACL,
      password, permanent settings or device identity.
- [ ] Disconnect/reconnect while idle (not during an active send), queued
      cancellation before dispatch, stale login response, and job-generation
      fencing. Check no duplicate RF or automatic replay.
- [ ] Device can return to its original healthy radio state and cache; keep
      packet/command logs redacted for review.
- [ ] Additional Serial/BLE testing and true physical RF TX/RX source research
      documented as completed or explicitly unverified; do not misrepresent
      absent hardware capability as a positive test result.

Stop if any unsolicited transmission, restart, duplicate send, incorrectly
correlated ACK/login, lost settings restoration or worker quarantine occurs.
Investigate and repeat relevant automated tests before considering a commit.

## Cutover and rollback

The new endpoints are opt-in. The compatibility endpoints are intentionally
left intact for current frontend and external callers. Nothing should move to
`202` by default without a client that reconciles job state and durable
message IDs. Roll back to the previous main commit **without replaying any
unknown queued or in-flight RF send**; the scheduler queue is in-memory only.
Never roll back or replace production SQLite with a smoke-test database.

The reviewer must independently check each GitHub issue acceptance item before
checking its box or closing it. Do not close the parent until all children,
including research and hardware-only signoff, have reliable evidence.
