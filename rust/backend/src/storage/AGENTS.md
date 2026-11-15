# Native storage invariants

Inherits the root and Rust guidance.

- Keep the initial schema, its object inventory and native version coherent.
  Python migrations are reference material, never a runtime upgrade bridge.
- Every statement runs under the storage mutex. Sessions return owned rows;
  live cursors cannot escape the lock or overlap another statement.
- Set rollback recovery pending before awaiting BEGIN; clear it only after
  confirmed COMMIT/ROLLBACK. Cancellation must not expose uncommitted data to
  the next reader. Do not add automatic transaction/RF replay.
- Drain PRAGMA result rows through query APIs. Checking an execution return
  code alone can miss unsupported settings or leave an active statement.
- Native compaction is explicitly unavailable under the verified flags.
  Never convert unsupported maintenance into a successful response.
