# Frontend agent guidance — frontend/

Inherits [root guidance](../AGENTS.md). React 18/TypeScript, Vite,
Vitest, Testing Library, shadcn UI, Tailwind and Sonner. Go to local
guides for [hooks](src/hooks/AGENTS.md),
[settings](src/components/settings/AGENTS.md),
[repeater](src/components/repeater/AGENTS.md),
[visualizer](src/components/visualizer/AGENTS.md) and
[tests](src/test/AGENTS.md) only when working in those areas.

## Ownership and boundaries

- TanStack Router owns URL/history/navigation; no second selected-conversation
  state. TanStack Query owns HTTP cache, page cursors, invalidation and
  mutation rollback. TanStack DB owns Query-backed entity views.
- TanStack Store holds high-frequency raw packets; subscribe narrowly,
  in consuming views. **Do not call `useRawPackets()` or
  `useRawPacketStatsSession()` above `MessageList`** (App, AppShell,
  ConversationPane): doing so triggers costly unrelated re-renders.
- TanStack Form owns editable draft/validation/submission state; preserve
  dirty forms on refresh. Table owns row semantics, Charts chart models,
  Virtual unbounded-window rendering, Pacer frontend rate control and
  Hotkeys global/route shortcuts.
- Lingui owns frontend localization. Use `Trans` for JSX copy and the `t`
  macro for attributes and imperative messages; keep protocol values, API
  fields and user content language-neutral. Run `npm run i18n:update` after
  copy changes and `npm run i18n:check` to verify reproducible, strictly
  compilable catalogs.
- `src/App.tsx` assembles hooks/data for `AppShell.tsx`. Keep heavy
  secondary views lazy loaded.
- REST schema types are generated from `openapi/openapi.json` into
  `src/generated/api-schema.ts` (`npm run api:generate`); never edit
  generated types by hand.
- WS `raw_packet.observation_id` identifies arrivals; `id` identifies
  the storage row. Parse multi-byte hop hashes with accompanying metadata.
- Do not automatically retry RF commands/messages on HTTP timeouts.
  An outgoing message may persist with `send_status="unknown"`.
- Preserve native IME input, dialog escape handling and accessibility.
  Prefer rem-based responsive styles; the canonical ThemePreview style
  reference is in `src/components/settings/SettingsLocalSection.tsx`.

## Run / verify

```bash
cd frontend
npm ci
npm run dev
npm run i18n:check
npm run test:run
npm run docker:typecheck
npm run build
```

For major cross-layer changes run the root quality gate. `packaged-build`
is release-only, not the normal build. The
[detailed frontend reference](../docs/agent-guides/frontend-reference.md)
contains prior architecture/routing/component/test notes: read only relevant
sections if necessary, not the entire file by default.
