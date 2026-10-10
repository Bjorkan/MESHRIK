# First MeshCore Companion hardware test (controlled RF smoke test)

This is an **operator-run** procedure. Do not execute it automatically in CI,
against a production database, or without a correctly attached antenna and
local RF authorization. This guide is for the known lab Companion transport
at `10.50.2.80:5000`; the address is an operator-provided test endpoint, **not**
an application default and should not be committed to runtime config.

## Preconditions / stop conditions

- Verify current branch/commit and a clean, reproducible dependency install;
  complete `scripts/quality/all_quality.sh` (and record test results).
- Use **one** MESHRIK server process (`--workers 1`, no `--reload`) and **one**
  exclusive TCP/serial/BLE owner. Do not connect an independent MeshCore client
  to the same companion while the server owns it.
- Back up the radio's settings, identity and the original SQLite database
  before enabling any state-changing startup or operator actions. Use an
  **isolated** test database; never point test runs at existing operator data.
- Keep the web UI restricted to localhost or a secured/trusted network and
  disable bots and unrelated integrations for the smoke run. Credentials,
  private keys, raw message bodies and node identifiers do not belong in logs,
  public issue comments or test artifacts.
- Validate antenna, frequency, region, TX power, firmware compatibility and
  that test transmissions to a cooperating repeater/contact are authorized.
- Stop immediately on unexpected reboot, unrequested RF traffic, multiple
  sends for one action, mistaken ACK, wrong flood/path-scope restore, repeated
  quarantine, or unexpected changes to contact/channel slots. Do **not**
  automatically retry an uncertain transmission.

## Phase A: passive *startup* / observation

Run from the repo root with a fresh test database and no other owner of the
radio's TCP port. `MESHCORE_PASSIVE_STARTUP=true` intentionally skips key
export, clock update, flood-scope write, destructive radio offload, startup
advertisement, pending-message drain and periodic maintenance. Startup still
queries metadata/time and enables incoming event reception. This is **not** a
read-only API security policy: clicking Send, Reboot, settings, CLI, etc. in
an accessible UI may still issue device/RF commands. During phase A do not
issue such requests.

```bash
MESHCORE_TCP_HOST=10.50.2.80 \
MESHCORE_TCP_PORT=5000 \
MESHCORE_DATABASE_PATH=data/meshcore-hardware-smoke.db \
MESHCORE_DISABLE_BOTS=true \
MESHCORE_ENABLE_LOCAL_PRIVATE_KEY_EXPORT=false \
MESHCORE_PASSIVE_STARTUP=true \
MESHCORE_SKIP_POST_CONNECT_SYNC=true \
MESHCORE_AUTO_REBOOT_ON_CLOCK_SKEW=false \
uv run uvicorn app.main:app --host 127.0.0.1 --port 8000 --workers 1
```

If a TCP connection to `10.50.2.80:5000` cannot be established, **stop** and
check the Companion's TCP server/network settings. Do not fall back to a
second simultaneous transport. Record radio model/firmware, API health and
`/api/radio/jobs`, `/api/radio/activity`, WebSocket and Radio Activity UI.
The app may report physical RF state as **unavailable**; command status is not
proof of actual transmission/listening. Observe inbound traffic and ensure
there is no startup advertisement or radio reboot.

## Phase B: one deliberate transmission at a time

Proceed only after Phase A and approval to send. With the same isolated test
DB, a single client, and verified channel/recipient configuration:

1. Send **one** short non-sensitive message to `#test`, or a test DM to
   `LouieHome` if the target can confirm reception. Confirm expected single
   send, unique message row, ACK/echo semantics and Radio Activity transitions.
2. Do not treat transport accepted/HTTP 200 as confirmed delivery; correlate
   ACK/echo with SQLite. If the outcome is unknown, do **not** blindly resend.
3. Only then try a permitted single advertisement request from the nearby
   **Fagerslätt** repeater, using existing authorized access, and verify the
   observed response. Never send the admin password in the issue/log/report.
4. A repeater/room login may require a longer RF response wait on a real mesh.
   Set `MESHCORE_LOGIN_RESPONSE_TIMEOUT_SECONDS=12` for a measured test run,
   restart the server to apply it and log queue, transport and response
   timings independently. Supported configured range: 1–60 seconds;
   default: 5. Avoid repeated login attempts against the same target within
   one connection generation, since firmware has no request IDs. Reconnect
   before deliberately retrying after an ambiguous outcome.

`MESHCORE_AUTO_REBOOT_ON_CLOCK_SKEW` defaults to **false**; only set it to true
if an operator knowingly permits a reboot during clock recovery. Normal
startup (without `MESHCORE_PASSIVE_STARTUP`) can still sync time, apply flood
scope, offload radio contacts/channels, advertise and run background work;
never switch to normal startup until its side effects have been approved.

## Phase C: fault injection only after ordinary sends succeed

With a cooperating receiving node, deliberately test late/duplicate ACKs,
slow repeater responses, Stop waiting vs. queued cancel, reconnect during an
idle period, then controlled disconnection during an **already accepted**
command. Watch for stale-generation completions, duplicate sends, correct
`unknown` status and process quarantine. A quarantined worker must never be
forced back online with a second executor or a bypass of the radio lock.
Check channel flood/path restore and radio configuration after any exception.

**Known limitations / do not mis-report:** legacy producers still return
synchronous HTTP responses rather than general `202 Accepted + job_id`;
ambiguous CLI response sessions remain serialized; coalescing and fairness
under prolonged real-radio maintenance load require additional evidence;
physical TX/RX/listen state is not measured. None of these limitations can be
signed off solely by successful unit tests or one radio exchange.

## What to record

Capture commit SHA, test results, firmware/model, transport type, sanitized
job IDs, per-phase elapsed times, received/ACK/echo status and whether
flood/path settings were restored. Avoid private keys, passwords, personal
messages, private node addresses, packet bodies and detailed private location.
If any stage fails, stop RF activity, preserve sanitized evidence and do not
commit a claim of complete hardware readiness.
