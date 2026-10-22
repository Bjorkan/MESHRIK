# Radio startup, reconnect and synchronization (#48, #49)

Radio lifecycle operations use **the same single in-process RadioJobWorker** as
ordinary radio commands. `RadioManager` alone creates/tears down the physical
transport; a second MeshCore session or separate initialization worker must
never be created. `radio_lifecycle.run_post_connect_setup()` owns a
_generation-fenced workflow_, with separate bounded worker jobs for each
command stage. The manager's underlying operation lock remains a final
transport guard, not an alternative production scheduler.

## Full-only startup

`MESHCORE_STARTUP_POLICY` accepts only `full`, which is also the default.
Startup policy is not an authorization boundary for manual REST/API radio
commands. The baseline bootstraps device metadata and clock **by reading**,
registers receive handlers, and reads radio contact/channel snapshots into
SQLite. Transport establishment and teardown remain manager-owned.

`full` does not itself authorize radio writes, sensitive reads, queue drains,
slot offload, reboot, or on-air traffic. Those operations require the specific
opt-ins below.

All maintenance opt-ins default to `false`:

| Configuration env var                          | Effect                                                                                                           |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `MESHCORE_STARTUP_EXPORT_PRIVATE_KEY`          | Read/export key into the authorized local keystore; **sensitive** (never emit in job snapshots)                  |
| `MESHCORE_STARTUP_SYNC_CLOCK`                  | Write device clock; may trigger later periodic clock sync                                                        |
| `MESHCORE_STARTUP_APPLY_FLOOD_SCOPE`           | Write configured flood scope                                                                                     |
| `MESHCORE_STARTUP_SEND_ADVERTISEMENT`          | Send a startup advertisement and enable configured periodic adverts (**RF**)                                     |
| `MESHCORE_STARTUP_DRAIN_MESSAGES`              | Drain pending device messages and enable configured message polling; review downstream semantics before enabling |
| `MESHCORE_STARTUP_RECONCILE_CONTACTS`          | Begin configured contact reconciliation (application state and possible downstream effects)                      |
| `MESHCORE_STARTUP_CLEAR_CHANNEL_SLOTS`         | Offload/clear physical channel slots; **destructive to radio residency**                                         |
| `MESHCORE_STARTUP_ALLOW_PERIODIC_OFFLOAD`      | Enable recurring contact/channel offload and slot removal; **destructive**, independent of clock sync            |
| `MESHCORE_STARTUP_ENABLE_TELEMETRY_COLLECTION` | Start telemetry collection                                                                                       |

A `full` startup with every flag unset has no device-write or RF-transmission
budget. Key export may change application storage
but must not be confused with a read-only data operation. Contact/channel
snapshotting **must not mark radio contacts as evicted**. Channel rows read
from physical slots retain `on_radio=true` (including subsequent lookups for
incoming channel messages); only a confirmed slot clear changes this to false.

Community MQTT may use the Companion's on-device signing commands when the
firmware supports them (tracked in #122); that does not export the secret key.
Historical DM decryption still requires the separately authorized private-key
export. Neither capability is enabled merely by selecting `full`.

The 60-second **radio statistics sample** is an independent, read-only health
query. It may run during normal operation and appears in Radio Activity as
"Radio stats sample", never as a periodic maintenance/offload sync. It does
not authorize any device writes or unsolicited RF transmission.

### Configuration migration and rollback

Remove `MESHCORE_PASSIVE_STARTUP` and `MESHCORE_SKIP_POST_CONNECT_SYNC` from
service files, containers and shell environments. An enabled legacy flag now
fails configuration load with an actionable error. Remove `passive` or `sync`
values for `MESHCORE_STARTUP_POLICY`; leaving the variable unset or setting it
to `full` selects the same non-destructive baseline.

Before upgrading, record all explicitly enabled `MESHCORE_STARTUP_*` switches.
To roll back operational behavior, stop the single server, disable every
sensitive/state-changing switch, and restart on the `full` baseline. Do not
automatically replay unknown sends. A software-version rollback must also
restore the previous documented configuration; never enable slot clearing or
periodic offload against an existing device without a backup and operator
approval.

## Lifecycle and readiness

```
disconnected -> connecting -> initializing -> ready | degraded | failed
```

- `connected` means the TCP/serial/BLE transport exists; it does **not** mean
  contacts/channels have been synchronized or the device is ready for user
  commands. Read `/api/health` or the radio status API for readiness, the
  fixed policy, current stage, skipped stages and failing stage.
- At each new connection **generation**, the worker admits `lifecycle_*`
  stages and holds back normal user jobs until initialization settles.
  Each stage acquires/releases the one command permit; incoming RF events
  continue independently. No giant 300-second exclusive lock is taken.
- Stages have separate bounded queue/command deadlines (currently 30 seconds
  for metadata/basic maintenance and 60 seconds for snapshots/longer work).
  A failed critical device-info or auto-fetch stage yields `failed`; an
  optional stage failure yields `degraded` and identifies a recovery stage.
  Worker's uncertain transport outcome is not rewritten as proof of failure.
- Repeated setup calls in the **same generation** coalesce to the active
  workflow; completed generations are not silently rerun. On disconnect,
  cancellation is coordinated with the worker before the transport lock is
  released. A late/stale stage cannot continue into a newer generation.
- Once `failed` or `degraded`, an operator should inspect the stage and
  diagnostics before using the documented manual retry; there is **no
  unlimited background retry loop** on the same generation. A clean reconnect
  starts a new bounded generation and fences stale jobs and responses.
- Shutdown, reboot and key import must respect the same worker/transport
  ownership and generation fencing. Manual actions still require the normal
  application authorization; startup policy does not prevent them.

## Stage classification

`device_info`, `contact_sync`, `channel_sync` and `auto_fetch` are read-only
with respect to radio configuration (contact/channel snapshots may write
SQLite). `clock_sync` and `flood_scope` write device settings; `advertisement`
transmits RF; `message_drain` and `channel_clear` can offload/alter what is
resident on the device, with `channel_clear` explicitly destructive. Key
export reads sensitive material; retain existing access and storage controls.
Background periodic offload requires its own explicit opt-in, even if periodic
clock sync is enabled. The radio configuration cannot be atomically rolled
back by a generic MeshCore transaction after arbitrary hardware failures;
inspect and restore operator-approved settings after such incidents.

This policy governs commands initiated by MESHRIK. A Companion's physical UI
may independently trigger RF actions such as an advertisement; current
firmware evidence does not demonstrate an automatic Companion boot advert.

## Verification / release gate

Run `./scripts/quality/all_quality.sh` with a reproducible uv+Node install.
Hardware-independent regressions live in
`tests/test_radio_startup_scheduler.py` and existing lifecycle/connection
monitor suites. They cover one-worker admission, the full read-only baseline,
rejected legacy configuration, failure and cancellation. CI must never require hardware.

For a live node, follow `HARDWARE_SMOKE_TEST.md`: single process and backed-up
DB; start with the full baseline and record configuration before/after. Do not
test mid-transmission disconnect or enable
slot deletion just to satisfy CI. Any `degraded`/`failed`, unexpected RF
advertisement or radio write is a blocker pending diagnosis.

**Legacy boundary:** Existing synchronous REST endpoints remain supported;
startup migration alone is not a complete removal of all synchronous API
compatibility. RF delivery, observer/bot reports and transport command
completion are distinct evidence levels.
