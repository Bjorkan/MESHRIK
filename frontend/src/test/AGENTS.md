# Frontend Vitest and Testing Library guidance

Inherits [frontend/AGENTS.md](../../AGENTS.md).

- Run `cd frontend && npm run test:run` or targeted Vitest
  tests. Check `vitest.config.ts` and `src/test/setup.ts`
  for existing shared mocks/provider setup.
- Assert user behavior and accessible roles/names where possible;
  avoid testing only implementation state.
- For Query/WS: test aborts, out-of-order results, late ACKs,
  reconnect and same-second dedup.
- For virtual lists: enforce mounted-row bounds and stable keys.
  jsdom cannot prove real scroll anchoring or browser touch.
- Fake clocks are appropriate for Pacer and timers; lossless
  observations/ACKs must not be dropped.
- `appPacketIsolation.test.tsx` protects against high-frequency
  packet subscriptions above MessageList.
- Docker context excludes `src/test/`; required matcher
  declaration files must stay outside this directory.
- Do not claim browser or RF hardware verification from fakes.
