# Radio scheduler operator runbook

This runbook covers deployment and rollback of the single-radio job scheduler,
how to interpret an ambiguous send, and how to cancel pending work. Run only
one MESHRIK process for a radio and database (`uvicorn --workers 1`).

## Deploy or upgrade

Record the currently deployed revision before changing it:

```bash
cd /path/to/MESHRIK
git status --short
git rev-parse HEAD
```

Do not continue with an unexpected dirty worktree. Keep the printed commit ID
as `PREVIOUS_COMMIT` for rollback. The scheduler is in memory; restarting drops
queued/running jobs but does not delete persisted messages.

### Native or systemd installation

Stop the service so the old process releases the radio and database lease, then
update dependencies and the frontend before starting exactly one worker:

```bash
sudo systemctl stop meshrik
git pull --ff-only
uv sync --frozen
cd frontend
npm ci
npm run build
cd ..
sudo systemctl start meshrik
sudo systemctl status meshrik --no-pager
```

If the service has a different unit name, substitute that name. A manual launch
uses the same checkout and this single-worker command instead of `systemctl`:

```bash
uv run uvicorn app.main:app --host 0.0.0.0 --port 8000 --workers 1
```

### Docker Compose installation

Published images preserve `./data` through the configured bind mount. Capture
the current immutable image reference from `docker compose config`, replace the
image with the desired release or `sha-<full-commit>` tag, then recreate it:

```bash
sudo docker compose config
sudo docker compose pull
sudo docker compose up -d
sudo docker compose ps
```

Do not run the old and new containers together against one radio or data
directory.

### Verify after startup

Open `/radio-activity` and confirm startup reaches `ready` (or an explicitly
understood `degraded` state), with no second command executor. The equivalent
API checks are:

```bash
curl --fail http://127.0.0.1:8000/api/health
curl --fail 'http://127.0.0.1:8000/api/radio/jobs?limit=10'
curl --fail 'http://127.0.0.1:8000/api/radio/activity?limit=20'
```

Use the configured HTTPS URL and authentication when enabled. Verify the
configured serial, TCP or BLE transport by performing one deliberate,
low-impact operation; never use a message resend as a health probe.

## Interpret `unknown` send status

`unknown` means the local command crossed a point after which MESHRIK cannot
prove whether the radio transmitted it. It does **not** mean failed, delivered,
ACKed, or safe to resend. A worker timeout, transport disconnect or cancellation
after dispatch can all produce this state.

Before a manual retry:

1. Open `/radio-activity` and locate the job and its terminal state.
2. Inspect the persisted conversation row and any later ACK/echo.
3. Check the peer or channel by an independent means when duplicates matter.
4. Retry only as a deliberate operator decision; MESHRIK will not automatically
   replay an ambiguous transmission after reconnect or restart.

The queue, command and RF-response waits are distinct. Existing message paths
retain their bounded command waits and their ACK/echo handling; the scheduler
does not turn command completion into delivery proof. Repeater and room login
also retain their bounded response wait (`MESHCORE_LOGIN_RESPONSE_TIMEOUT_SECONDS`,
default 5 seconds per attempt) and its single direct-to-flood fallback after an
unconfirmed attempt. An explicit login rejection is terminal and does not
trigger that fallback. A timeout means “not confirmed”, not “authenticated” and
not necessarily “not transmitted”.

Two lower-level safety bounds remain in force during and after scheduler
deployment: staging a contact on the radio is limited by
`MESHCORE_RADIO_ADD_CONTACT_TIMEOUT_SECONDS` (default 25 seconds), and legacy or
lifecycle acquisition of the radio lock is limited by
`MESHCORE_RADIO_OPERATION_LOCK_TIMEOUT_SECONDS` (default 15 seconds). A contact
staging timeout is an ambiguous command outcome, while failure to acquire the
lock means the command was never admitted to that lock. Neither should be
reported as RF delivery or credential rejection.

## Cancel a job

Copy the opaque job ID from `/radio-activity` or `GET /api/radio/jobs`, then:

```bash
curl --fail -X POST \
  http://127.0.0.1:8000/api/radio/jobs/JOB_ID/cancel
```

Interpret the returned `action` exactly:

- `cancelled_before_dispatch`: the queued command was not sent to the radio.
- `stop_waiting`: MESHRIK stopped tracking the ACK/reply; any earlier transmit
  is unaffected.
- `requested`: cooperative cancellation was requested during execution. The
  command may already have transmitted, so its outcome can be `unknown`.
- `unchanged`: the job was already terminal or cancellation changed nothing.

Cancellation cannot retract an RF packet. If a stuck command causes worker
quarantine, inspect Radio Activity and the persisted message first, then restart
the MESHRIK process. Do not automatically resend the operation.

## Roll back

Rollback changes application code or the container image; it must not restore
an old database copy over newer messages. Stop the current process first so
only one owner can access the radio.

For a native/systemd checkout, use the recorded commit without rewriting the
working tree:

```bash
sudo systemctl stop meshrik
git switch --detach PREVIOUS_COMMIT
uv sync --frozen
cd frontend
npm ci
npm run build
cd ..
sudo systemctl start meshrik
sudo systemctl status meshrik --no-pager
```

For Docker Compose, restore the previously recorded immutable image reference
(prefer a release or `sha-<full-commit>` tag), then:

```bash
sudo docker compose pull
sudo docker compose up -d
sudo docker compose ps
```

The scheduler itself adds no persisted queue to migrate or recover. Its pending
jobs disappear on stop; SQLite message history remains authoritative. After
rollback, repeat the health/job/activity checks above and review every send that
was executing at shutdown as potentially `unknown`.
