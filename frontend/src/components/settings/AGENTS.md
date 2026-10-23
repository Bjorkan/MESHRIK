# Settings components and forms guidance

Inherits [frontend/AGENTS.md](../../../AGENTS.md).

- TanStack Form owns drafts, validation, dirty state and submit
  errors. Do not overwrite dirty drafts when server settings
  refresh; Query mutations own writes, not a parallel useState form.
- Numeric radio fields reject empty, partial, non-finite,
  non-integer and invalid values. Never automatically retry
  state-changing radio settings commands after a timeout.
- `SettingsRadioSection.tsx`: only display `path_hash_mode`
  when supported; keep advert-location as off/include current
  node location, and distinguish manual flood/zero-hop adverts.
- `SettingsLocalSection.tsx` includes canonical ThemePreview
  style reference. Use accessible primitives, consistent sizes,
  rem-based text, labels and keyboard navigation.
- Keep browser-local preferences distinct from server-persisted
  radio/app settings; do not leak radio private keys or MQTT
  tokens into unrelated form state or logs.
- Check `settingsModal.test.tsx` and relevant backend
  radio/settings integration tests for contract changes.
