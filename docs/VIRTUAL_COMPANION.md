# Virtual Companion operator guide and release gate

> [!CAUTION]
> This feature is part of the unmerged S01–S13 stack under
> [epic #224](https://github.com/Bjorkan/MESHRIK/issues/224). Keep every PR in the stack unmerged and
> keep the listener OFF until the hardware-free tip is green and reviewed. Official Android/iOS
> devices and physical-radio behavior are intentionally validated only after the complete stack has
> merged. This document does not announce a released feature.

The MeshCore App integration lets Companion-protocol clients talk to a **virtual TCP endpoint owned
by MESHRIK**. MESHRIK remains the only owner of the physical radio connection. This is not a TCP
proxy and it never asks an app to connect to the physical Companion radio.

## The two endpoints must stay distinct

| Endpoint | Owner | Example | Purpose |
| --- | --- | --- | --- |
| Physical radio transport | MESHRIK only | radio USB/BLE or `radio-host:5000` | MESHRIK's single managed connection to the actual Companion |
| Virtual Companion TCP | Official apps | `meshrik-vpn-host:5000` | Separate listener backed by MESHRIK state and its existing radio worker |

Never enter the physical radio's address or port in an app while following this guide. Never expose
either plaintext Companion TCP port to the public internet. MESHRIK HTTP Basic auth, HTTPS, and its
reverse proxy protect HTTP traffic only; they do **not** authenticate this raw TCP listener.

The virtual endpoint also cannot prevent a phone or another program from independently pairing to
the radio over BLE or reaching the radio's own TCP listener. Disable or firewall those physical
transports separately when single ownership matters.

## Create and enable the integration

1. Connect the physical radio to MESHRIK and wait until the header reports it ready. The virtual
   endpoint will not invent or upload an identity while the radio identity is unavailable.
2. In MESHRIK, open **Settings → Integrations → Add Integration**.
3. Choose **MeshCore App (Virtual TCP Companion)** and select **Create**. Only one instance is
   allowed. Merely viewing settings or creating the draft does not bind a socket.
4. The default **Access** is **Local area network (0.0.0.0)**, with endpoint `0.0.0.0:5000`;
   the integration is still OFF. This listens on all IPv4 interfaces, not only the LAN. Restrict
   access to trusted devices using a firewall. Existing saved bind addresses are not changed.
5. For a phone on the trusted LAN, connect to the MESHRIK host's LAN IP, never `0.0.0.0`.
   Select **This MESHRIK device only (localhost)** to restrict the listener to the same host.
   For protected remote access, establish a VPN or mTLS gateway, select the matching access mode,
   enter its bind address and confirm the warning. Never expose raw TCP publicly or port-forward it.
6. The default virtual port is `5000`; it must be unused on the MESHRIK host. A physical radio on
   another host may also use port `5000`: these are different endpoints. A physical Companion
   endpoint on localhost must use a different port.
7. Optionally select DB channels under **DB-backed channel selection**. Review the stable virtual
   slot numbers before saving.
8. Select **Save as Enabled**. Wait for **Listening**; an optimistic enabled state is never success.
   If the listener cannot bind, the form reports the sanitized operating-system error and rolls the
   configuration back.

The status panel shows the configured virtual endpoint, `Off`/`Listening`/`Error`, 0/1/N client
count, privacy-safe session IDs, protocol version and last-seen time. It displays only a shortened
verified public identity. No private key, BLE PIN, channel secret, message text, or peer IP belongs
in this UI.

## Connect an app

The value entered in a client is always:

- **Host:** the DNS name or protected VPN address of the machine running MESHRIK—not the radio.
- **Port:** the virtual port shown by the integration—not the web port and not the radio port.
- **Transport/protocol:** raw MeshCore Companion over TCP, not KISS and not HTTP/WebSocket.

For a client build that exposes a custom TCP connection, the functional sequence is:

1. Open its connection/device picker and choose **TCP** or **Wi-Fi/TCP Companion**.
2. Enter MESHRIK's host and virtual port.
3. Connect and verify the public node identity matches MESHRIK.
4. Confirm contact/channel sync, then send only after the app shows the expected shared node.

### Post-merge official-app hardware validation

As of 2026-10-21, public upstream sources confirm Companion TCP support in the Android ecosystem,
but they do not publish a stable, versioned click path for the currently released official Android
and iOS UIs. The project has no authorized sanitized captures proving both current releases. Exact
menu labels must therefore **not** be guessed in release documentation.

This is deliberately **not a pre-merge requirement**. After the complete stack has merged, and
before claiming released mobile compatibility, complete the version/OS/click-path/transcript table in
[`tests/e2e/virtual_companion/README.md`](../tests/e2e/virtual_companion/README.md) with real Android
and iOS builds and two simultaneous clients. If a current build has no custom TCP option, cannot
connect, or demands a private key, record that result and keep release blocked. The source-derived
fixtures and `meshcore_py` harness prove protocol behavior, not official mobile UI compatibility.

Relevant upstream references are the
[MeshCore firmware protocol](https://github.com/meshcore-dev/MeshCore/blob/main/docs/companion_protocol.md),
[Python SDK TCP API](https://github.com/meshcore-dev/meshcore_py), and
[JavaScript SDK TCP API](https://github.com/meshcore-dev/meshcore.js).

## Shared identity, clients, messages, and channels

- The listener accepts at most 32 simultaneous clients. Additional connections are closed;
  capacity becomes available again when an existing session disconnects.
- All clients see the same already-verified managed node public identity. There is no virtual key
  generation, private-key upload/export, signing oracle, or per-app identity.
- Each TCP session has its own bounded output queue, contact snapshot cursor, message cursor,
  protocol version, and ACK ownership. One slow or disconnected client does not consume another
  client's messages or block DB persistence.
- Contacts and messages come from MESHRIK's durable database. Reads and synchronization never drain
  the physical radio queue or issue a physical radio command.
- Direct and channel text sends use the existing scheduler-backed MESHRIK send services and the one
  radio worker. A TCP disconnect cannot create an automatic duplicate retry after an ambiguous send.
- Virtual channel indexes are stable operator-selected mappings to DB channel keys. Removing a slot
  leaves other indexes unchanged. They are not physical radio channel slots. The default capacity is
  40, the validated range is 1–255, and only explicitly selected DB channels are exposed.
- Channel selection shares the channel secret with trusted connected apps because that is required
  by the Companion channel response. Treat every allowed client as a channel-secret holder.

## Supported and denied surface

This is a deliberately limited Companion implementation, not full firmware administration.

| Supported | Behavior |
| --- | --- |
| `APP_START`, `DEVICE_QUERY` | Verified cached shared identity and virtual capabilities |
| `GET_CONTACTS`, `GET_CONTACT_BY_KEY` | DB-backed snapshot/full-key lookup |
| `GET_CHANNEL` | Stable finite virtual channel mapping |
| `SYNC_NEXT_MESSAGE` | Independent durable per-client message cursor |
| `GET_DEVICE_TIME` | Read-only host UTC seconds |
| `ADD_UPDATE_CONTACT`, `REMOVE_CONTACT` | Revision-fenced DB-only changes; never physical contact-table writes |
| `SEND_TXT_MSG`, `SEND_CHANNEL_TXT_MSG` | Validated text sends through the canonical scheduler/service seam |

All other source-defined commands are deny-by-default. The main denied groups are physical radio
settings/tuning/reboot/reset, adverts/traces/telemetry and other arbitrary RF sends, raw packets and
datagrams, CLI, private-key import/export, signing, device PIN, physical channel/path mutations and
unsupported cached reads. See the exhaustive opcode table and exact response policy in
[`VIRTUAL_COMPANION_PROTOCOL.md`](VIRTUAL_COMPANION_PROTOCOL.md).

## Disable, edit, restart, and recover

- **Disable:** turn the integration checkbox off and confirm. Only virtual sockets are closed. The
  physical radio, MESHRIK receive path, database writes and scheduled jobs continue.
- **Edit bind/port/channel map:** use Edit and save. Existing virtual clients disconnect and must
  reconnect. A bind failure or port collision returns an error and restores the previous persisted
  configuration/listener rather than claiming success.
- **Physical identity replacement/reconnect:** a new radio generation disconnects all virtual
  sessions. The listener stays available, but new handshakes fail closed until MESHRIK has verified
  the current physical identity. Apps must reconnect and confirm the identity again.
- **Restart MESHRIK:** an enabled persisted integration is re-created by the integration manager;
  a disabled one remains dormant. Check `Listening` before reconnecting apps.
- **Delete:** deletion stops the virtual listener and removes only its integration configuration.
  It does not delete messages/channels or disconnect the physical radio.
- **Ambiguous send:** inspect the durable outgoing message and Radio Activity before a manual retry.
  A timeout can mean the radio transmitted even when a success response was lost.

There is no fallback that silently connects an app directly to the radio. If the virtual listener
is off or broken, repair it or keep the feature disabled.

## Status and privacy-safe support data

Inspect full status only from a trusted local/admin context:

```bash
curl -s http://127.0.0.1:8000/api/health | jq '
  .fanout_statuses | to_entries[]
  | select(.value.type == "virtual_companion_tcp")
  | .value | {status, port, clients, last_error, identity_status,
              virtual_channel_capacity, configured_channel_slots}'
```

The selected projection intentionally omits bind address, public identity and session detail. The
full health endpoint is an admin surface and may contain those operational values; do not paste its
raw response into a public issue.

For a support attachment, use **Settings → About → Open debug support snapshot** or `GET /api/debug`.
The non-log radio/virtual-Companion fields redact physical transport locations, database path, node
name/public identity, virtual bind address and session rows. They retain sanitized listener error,
configured port and client count when the integration is failing. Errors from unrelated third-party
integrations may still identify their service, and logs remain below the `STOP COPYING HERE`
boundary; review both before sharing and never enable `MESHCORE_LOG_SENSITIVE_PAYLOADS` for a support
capture. Do not include screenshots showing hostnames, internal IPs, keys, channel names/secrets or
message text.

## Admin API and configuration contract

The UI is preferred. The REST endpoints are useful for audited automation:

- `GET /api/fanout` — persisted integration configurations.
- `POST /api/fanout` — create the singleton. It defaults OFF when `enabled` is omitted.
- `PATCH /api/fanout/{id}` — edit or enable; startup failure returns HTTP 409 and rolls back.
- `DELETE /api/fanout/{id}` — stop and remove the virtual integration.
- `GET /api/health` — live listener/client status.
- `GET /api/debug` — redacted support snapshot; only erroring fanouts are included.

Trusted-LAN creation example (saved disabled):

```bash
curl -X POST http://127.0.0.1:8000/api/fanout \
  -H 'Content-Type: application/json' \
  --data '{
    "type": "virtual_companion_tcp",
    "name": "MeshCore App",
    "enabled": false,
    "config": {
      "bind_host": "0.0.0.0",
      "port": 5000,
      "unsafe_network_acknowledged": false,
      "secure_access": "",
      "virtual_channel_capacity": 40,
      "channel_slots": []
    },
    "scope": {"messages": "none", "raw_packets": "none"}
  }'
```

`bind_host` must be `localhost` or a literal IPv4/IPv6 address; omission defaults to `0.0.0.0`.
The default trusted-LAN mode uses `secure_access=""` and does not assert VPN/TLS protection.
`localhost` still resolves to `127.0.0.1`. Custom non-loopback bindings and explicit protected modes
require both `unsafe_network_acknowledged=true` and `secure_access` equal to `vpn` or `mtls_proxy`.
This is an operator assertion about an already-deployed protection layer, not TLS/auth implemented
by MESHRIK. Use a firewall to prevent the all-interface default from becoming publicly accessible.
Port defaults to `5000`, accepts 1–65535, and must differ from a physical Companion endpoint on
localhost. A radio on another host can use the same port number. Capacity is 1–255;
`channel_slots` is a bounded list of unique 16-byte channel keys or `null` holes. Scope is always
forced to `none/none` because Companion commands do not enter fanout callbacks.

## Deployment patterns

### Native/systemd

For trusted LAN clients, use the default `0.0.0.0` and restrict the port with a firewall.
For a same-host client, select `127.0.0.1`. For protected remote access, bind the literal MESHRIK host address
on a private VPN interface and firewall the chosen port to approved VPN peers. The systemd service
needs no extra environment variable: configuration is persisted in SQLite. Verify the address
exists before enabling; a wrong address or occupied port produces `Error`, not a fallback.

### Docker Compose

Loopback inside a container is not the Docker host. The listener must bind `0.0.0.0` in the
container (the default trusted-LAN mode), while Compose restricts publication to the
host's VPN address:

```yaml
services:
  meshrik:
    ports:
      - "8000:8000"
      - "10.8.0.1:5000:5000" # replace with the host VPN address
```

Do not use `5000:5000` without a host address on an untrusted host: it commonly publishes on every
interface. Do not publish the physical `MESHCORE_TCP_PORT`. If port 5000 is occupied, choose another
dedicated virtual port in both the integration and mapping. Restart the container after changing
Compose port mappings, then verify the integration still reports `Listening`.

### Home Assistant add-on

Home Assistant ingress exposes HTTP, not arbitrary Companion TCP. The add-on wrapper must explicitly
publish a dedicated TCP port (for example `5000/tcp`) or use a reviewed host-network configuration;
otherwise a phone cannot reach a container-loopback listener. In the add-on case bind the listener
inside the container as documented by that wrapper—commonly `0.0.0.0`—and restrict the host port to
a VPN/firewall. Never treat ingress authentication as protection for the raw TCP port. If the
installed add-on version cannot declare a protected TCP mapping, leave the integration OFF rather
than connecting the app directly to the radio. The wrapper is maintained separately in
[`Bjorkan/HA-MESHRIK`](https://github.com/Bjorkan/HA-MESHRIK); verify its current port options before
deployment.

### mTLS gateway

The listener itself remains plaintext. A separately managed gateway may accept authenticated mTLS
clients and proxy only to MESHRIK loopback/private container networking. Bind and firewall the raw
side so it is unreachable except from the gateway. MESHRIK does not provision certificates or
validate gateway policy.

## Stacked PR map

Every PR is same-repository and based on the previous head. None may merge until the final checklist
below passes.

| Layer | Issue | PR | Base | Dormant/safety invariant |
| --- | --- | --- | --- | --- |
| S01 protocol | [#225](https://github.com/Bjorkan/MESHRIK/issues/225) | [#238](https://github.com/Bjorkan/MESHRIK/pull/238) | `main` | fixtures/docs only |
| S02 transport | [#226](https://github.com/Bjorkan/MESHRIK/issues/226) | [#239](https://github.com/Bjorkan/MESHRIK/pull/239) | S01 | unwired listener classes |
| S03 integration | [#227](https://github.com/Bjorkan/MESHRIK/issues/227) | [#240](https://github.com/Bjorkan/MESHRIK/pull/240) | S02 | singleton defaults OFF |
| S04 identity | [#228](https://github.com/Bjorkan/MESHRIK/issues/228) | [#241](https://github.com/Bjorkan/MESHRIK/pull/241) | S03 | verified cached public identity only |
| S05 contacts | [#229](https://github.com/Bjorkan/MESHRIK/issues/229) | [#242](https://github.com/Bjorkan/MESHRIK/pull/242) | S04 | DB reads only |
| S06 channels | [#230](https://github.com/Bjorkan/MESHRIK/issues/230) | [#243](https://github.com/Bjorkan/MESHRIK/pull/243) | S05 | stable virtual slots only |
| S07 messages | [#231](https://github.com/Bjorkan/MESHRIK/issues/231) | [#244](https://github.com/Bjorkan/MESHRIK/pull/244) | S06 | DB cursors, no radio drain |
| S08 direct send | [#232](https://github.com/Bjorkan/MESHRIK/issues/232) | [#245](https://github.com/Bjorkan/MESHRIK/pull/245) | S07 | canonical worker/idempotency only |
| S09 channel send | [#233](https://github.com/Bjorkan/MESHRIK/issues/233) | [#246](https://github.com/Bjorkan/MESHRIK/pull/246) | S08 | canonical worker/stable key only |
| S10 policy | [#234](https://github.com/Bjorkan/MESHRIK/issues/234) | [#247](https://github.com/Bjorkan/MESHRIK/pull/247) | S09 | exhaustive default deny |
| S11 UI | [#235](https://github.com/Bjorkan/MESHRIK/issues/235) | [#248](https://github.com/Bjorkan/MESHRIK/pull/248) | S10 | create flow and persisted state remain OFF |
| S12 proof | [#236](https://github.com/Bjorkan/MESHRIK/issues/236) | [#249](https://github.com/Bjorkan/MESHRIK/pull/249) | S11 | hardware-free SDK/security proof |
| S13 docs/release | [#237](https://github.com/Bjorkan/MESHRIK/issues/237) | this PR | S12 | documentation cannot activate listener |

Parent: [#224](https://github.com/Bjorkan/MESHRIK/issues/224). Upstream protocol dependencies:
MeshCore firmware protocol 13/14 and pinned `meshcore==2.3.16`; see
[`VIRTUAL_COMPANION_PROTOCOL.md`](VIRTUAL_COMPANION_PROTOCOL.md) for source provenance.

## Test and controlled rollout checklist

Before the **first** merge to `main`:

- [ ] All 13 PRs remain draft/unmerged until S13 review begins; bases match the table.
- [ ] Reviewer approves protocol policy, no-physical-bypass proof, UI warning and this runbook.
- [ ] `PYTHONPATH=. uv run pytest tests/test_virtual_companion_*.py -q` passes.
- [ ] `PYTHONPATH=. uv run python tests/e2e/virtual_companion/harness.py` passes.
- [ ] `./scripts/quality/all_quality.sh` passes on the S13 tip.
- [ ] Every PR's GitHub **All Quality** and autofix checks are green.
- [ ] A reviewer confirms creation defaults OFF and no listener binds from merely opening settings.

GitHub stacks merge sequentially, never atomically. Merge **base to tip** (#238, #239, …, this PR),
allowing GitHub to retarget the next PR after each merge. Require CI on every resulting `main` commit.
If any merge/check fails, stop immediately. Do not enable the integration, announce it, bypass branch
protection, or skip to a later PR. Already merged intermediate layers remain dormant by default; fix
and revalidate the remaining stack before continuing.

After the final merge, but before release/public announcement:

- [ ] Record Android and iOS app version/OS/click-path evidence with two simultaneous real devices.
- [ ] Run the supervised managed-radio smoke checks; no real hardware is required before merge.
- [ ] Fresh database: `GET /api/fanout` has no virtual integration and no virtual port is listening.
- [ ] Creating the singleton without `enabled` persists OFF and does not bind.
- [ ] Enabling a protected test endpoint shows `Listening`; disabling it closes only virtual clients.
- [ ] Physical radio still has one owner/worker; connect/list/sync/denied commands record zero direct
      physical TCP/BLE/serial opens and zero generic SDK dispatch.
- [ ] Direct/channel tests show only canonical scheduled sends, with no duplicate after ambiguity.
- [ ] Port collision and unavailable identity show truthful errors and no fallback to the radio.
- [ ] `/api/debug` omits real identities, channel keys, message text and internal transport/bind
      locations above the log boundary.
- [ ] Roll back by disabling/deleting the integration; do not alter the physical radio endpoint.

Close epic #224 only after every box is evidenced on the merged tip. The listener must still be OFF
until an operator explicitly creates and enables this integration.
