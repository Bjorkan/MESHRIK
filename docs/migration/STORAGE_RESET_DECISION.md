# Storage reset decision — 2026-11-15

The maintainer explicitly authorized **a new empty native Turso database** in
place of the old SQLite database. All migration issues #275–#302 were updated
and read back to verify this decision, including the acceptance criteria in
[#278](https://github.com/Bjorkan/MESHRIK/issues/278),
[#295](https://github.com/Bjorkan/MESHRIK/issues/295) and
[#296](https://github.com/Bjorkan/MESHRIK/issues/296).

- Legacy SQLite data may be discarded without saving, backing up, archiving,
  converting or importing it. Messages, contacts, settings and integration
  configuration from that database are intentionally not retained.
- Fresh Turso initialization creates only the application schema and normal
  default rows. Python's 72 migrations remain behavioral reference material;
  Rust does not run a legacy-file upgrade bridge.
- A durable native-storage identity and schema version must distinguish an
  initialized Turso database from a legacy database. Restarting or upgrading
  Rust must preserve existing Turso data. Corrupt, partial or unknown-future
  native storage must fail closed rather than silently resetting user data.
- File classification, legacy discard (including its old sidecars) and native
  initialization require exclusive process ownership. Python/SQLite and
  Rust/Turso must never actively use the same radio or database concurrently.
- Recovery and backups for **new Turso data** remain required. The migration
  cannot restore a discarded SQLite database and does not promise a
  data-preserving downgrade to the old backend.

The initial native schema version is 73, with a separate ownership marker.
IDs start afresh and remain durable/monotonic within the new database. The
normal WAL configuration uses `auto_vacuum=NONE`; experimental auto-vacuum,
vacuum, MVCC and cloud features stay disabled.

The legacy-file NO-GO report in PR #306 remains valid historical evidence. It
does not reject a freshly created native database with a different supported
configuration. The fresh configuration must pass its own correctness tests.
Radio, REST/WS, secret-handling and final hardware/release gates remain intact.

This decision authorizes the implementation policy. Tests in the current
stack use disposable fixtures; no live operator database has been reset.
