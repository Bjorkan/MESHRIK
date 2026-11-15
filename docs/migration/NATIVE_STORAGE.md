# Native storage adapter

The Rust executable is still restricted to explicit Linux fixture mode. It
opens `MESHRIK_RUST_FIXTURE_DIR/fixture.db` before binding HTTP; it does not open
the Python runtime's configured operator database or connect to a radio.

## Initialization and ownership

`Storage::open` takes an acquired `ProcessLease`, derives its database path
from that lease, and retains the lease until the connection/database drop.
There is no independently supplied path that could bypass the ownership guard.
The advisory lock interoperates with Python's `.radio-owner.lock` and is
explicitly unlocked before close, including transient inherited descriptors.

Under the [approved reset policy](STORAGE_RESET_DECISION.md):

1. A missing database without orphan sidecars creates fresh native storage.
2. A recognized legacy SQLite file (historical version <=72, no native marker)
   is discarded with its known WAL/SHM/journal sidecars. No backup, archive,
   conversion or data import runs. Unrelated existing backups are not touched.
3. Native `__meshrik_storage` records engine, generation, version and setup
   status. The marker is committed before application initialization; an
   interrupted setup is recognized and preserved rather than treated as legacy.
4. The fresh application schema/defaults initialize transactionally at version
   73. The checked-in SQL and object inventory derive from the frozen Python
   logical schema; Python's historical migration scripts are not a dependency.
5. Initialized native files reopen with the same generation and data. Unknown
   future versions, invalid/incomplete markers, missing schema objects, FK
   violations, unidentified/truncated files and orphan sidecars fail closed.
   Database symlinks are not followed for reset.

Every required application table/index/trigger is checked, along with native
integrity and explicit FK verification. WAL, synchronous NORMAL, busy timeout,
cache/temp settings and per-connection FK enforcement are queried back after
setting. `auto_vacuum` must remain NONE; no experimental feature is enabled.

## Transactions and maintenance

One Tokio mutex owns the native connection for reads and writes. Mutable
sessions fully drain/finalize statements and return owned rows, so cursors
cannot escape the lock or overlap the next statement. Writes mark rollback
recovery pending before awaiting BEGIN. Errors/cancellation trigger cleanup
before any later reader/writer; committed operations are never automatically
replayed. Repository closures must perform SQL work only, without waiting for
radio or integration responses.

Checkpoint requires a successful drained TRUNCATE result. Backup of **new
native data** holds the same lock through checkpoint/copy/sync and atomically
persists a new snapshot without overwriting an existing target. Backup copying
is currently synchronous and blocks other SQL; #297 owns performance profiling.
Unsupported compaction returns a typed explicit error and never executes a
pretend successful VACUUM.

The fixture HTTP health remains 503 because radio/integrations are absent, but
reports `database_open=true` after successful native initialization. Other
application APIs remain 501 pending their implementation layers. Python
production defaults and REST/OpenAPI/WS artifacts remain unchanged.

## Evidence and limits

Temporary-file tests cover legacy discard without archive, native restart and
generation preservation, defaults/settings, every table's column/FK parity,
the full schema-object inventory, duplicate owners, transaction failure and
cancellation, concurrent callers, native backup/restore, future/incomplete or
corrupt storage, missing triggers, FK orphans, symlinks and orphan sidecars.
A bounded child-process test kills a native owner during an uncommitted write:
the next owner recovers the committed row and excludes the uncommitted row.

This is process-crash evidence, not power-loss or hardware qualification.
Full domain repository parity, OS-level durability, ARM64 measurements and
production deployment remain explicit migration/release gates. No live
operator database has been reset by this implementation work.
