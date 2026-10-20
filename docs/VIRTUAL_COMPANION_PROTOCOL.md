# Virtual TCP Companion: S01 protocol contract and implementation decisions

> **Status: research contract, NOT an implemented TCP Companion server.** See epic [#224](https://github.com/Bjorkan/MESHRIK/issues/224) and S01 [#225](https://github.com/Bjorkan/MESHRIK/issues/225). S02–S13 stack on top of this PR. **Do not enable a listener or merge an incomplete feature.**

## Goal and non-negotiable trust boundary

Official MeshCore apps speak Companion TCP **to MESHRIK only**. MESHRIK, not the apps, is the sole owner of the existing physical Companion's USB/BLE/TCP connection. All connected official apps represent exactly **the same verified, pre-existing physical Companion public key**, name and managed node identity. No new virtual identities, private-key export, ad hoc radio socket forwarding or second radio worker. Multiple TCP sessions have **separate reply queues and message cursors**, but **shared authoritative MESHRIK contacts, channel mapping, messages, state and sending services**.

The future endpoint belongs in **Settings → Integrations → Add Integration → MeshCore App (Virtual TCP Companion)**, disabled by default, behind a separate network-access threat model. MESHRIK HTTP Basic auth does **not** authenticate raw Companion TCP. The physical node's own BLE/TCP access cannot be blocked by a virtual listener; restrict it separately at radio/network level where possible.

### Provenance and gaps

This contract is based on the user-provided `MeshCore-main` firmware ZIP, specifically:
- `examples/companion_radio/MyMesh.h:7,14` reports **Companion firmware protocol 14 / v1.18.0** (build label 15 Oct 2026).
- `examples/companion_radio/MyMesh.cpp:9-68,75-141,155-168,1055-2062,2388-2412`: firmware opcodes, reply/push/error codes and body layouts.
- `src/helpers/wifi/SerialWifiInterface.cpp:55-160`: TCP framing and connection handling.
- `src/helpers/BaseSerialInterface.h:5`: max Companion payload **176 bytes**.
- `src/MeshCore.h:22`: **64-byte** maximum serialized contact path.
- `docs/companion_protocol.md` says updated 2026-03-08 for v1.12+ and explicitly warns of inaccuracies. Its narrative is **not** sufficient to prove current behavior.
- MESHRIK's existing `tests/fixtures/meshcore_companion_protocol_118.json` records protocol **13 vs 14** and `meshcore==2.3.16` fixtures. Protocol 13 is an existing baseline, **not** proven equivalent to v14 for every opcode/field.
- Upstream [firmware](https://github.com/meshcore-dev/MeshCore), [published protocol](https://github.com/meshcore-dev/MeshCore/blob/main/docs/companion_protocol.md), [Python SDK](https://github.com/meshcore-dev/meshcore_py), [JS SDK](https://github.com/meshcore-dev/meshcore.js). [Official app listing](https://meshcore.io/) and [Android distribution](https://play.google.com/store/apps/details?id=com.liamcottle.meshcore.android), [iOS distribution](https://apps.apple.com/us/app/meshcore/id6742354151). **The archive does not include the current official iOS/Android app source or real TCP handshake traces.**

**Unverified release gate:** Collect authorized sanitized request/response traces using *currently released native Android and iOS apps* against an isolated fake Companion, record app/build/OS, custom TCP host+port configuration availability, handshake sequence, reconnection, initial sync, send behavior, and reactions to denied private-key export and device settings writes. If either platform cannot use custom TCP or demands prohibited commands, mark it an explicit compatibility blocker; **do not claim native app compatibility or bypass the security policy**. See #225 and #236. This S01 PR adds source-derived **synthetic** test fixtures, **not** real app captures.

## Binary wire contract

```text
app → MESHRIK:       3C | payload_length:uint16_le | payload[0..175]
MESHRIK → app:       3E | payload_length:uint16_le | payload[0..175]
```

- The **three-byte** TCP header is **not** part of the 176-byte payload limit. A 176-byte payload uses `b0 00` as length. `0x3c` is ASCII `<`, `0x3e` is ASCII `>`; do not accidentally reverse these directions.
- Payload begins with **one-byte** `CMD_*`, `RESP_*` or `PUSH_*`. All fixed-width integers are little-endian in the referenced firmware. UTF-8 strings may be capped to byte length, not Python character count; NUL termination/padding differs by field.
- Malformed/zero-length headers, wrong direction, oversized/truncated frames and unknown commands are **fail closed**, with bounded per-client buffers, receive deadlines, no automatic SDK dispatch and no raw radio access. Exact close-vs-error policy and frame-length handling belong in S02, tested against SDK.
- Upstream Wi-Fi firmware forcibly **disconnects a previous TCP client** on arrival of another (`SerialWifiInterface.cpp:56-66`). That limitation is not compatible with MESHRIK's multiple-app requirement: S02 must implement independent sessions and ordered bounded writers.

## Protocol-version/compatibility matrix

| Contract | Firmware v13 (MESHRIK legacy fixture) | Firmware v14 (uploaded v1.18.0) | Virtual behavior |
|---|---|---|---|
| `DEVICE_QUERY` | `CMD_DEVICE_QUERY=22` with target version **13** | Same code; target version **14** | Parse version *per client*, report only actually implemented capabilities. |
| `APP_START` | `CMD_APP_START=1` | Same, `len>=8` | Source a **single verified physical identity** from MESHRIK; no radio query on connect. |
| `GET_CONTACTS` | Present | `CMD_GET_CONTACTS=4`, optional uint32 `since` | MESHRIK DB snapshots per client; total count differs from filtered count. |
| `GET_CHANNEL` | Present | `CMD_GET_CHANNEL=31` | Stable **virtual** finite channel slots independent of physical temporary slots. |
| `SYNC_NEXT_MESSAGE` | Present | `CMD_SYNC_NEXT_MESSAGE=10` | **Per-client** DB cursor; never dequeue physical Companion. |
| CLI | Firmware-dependent | `CMD_RUN_CLI_COMMAND=66`, `RESP_CODE_CLI_REPLY=29` | Always reject; cannot become raw radio or local process CLI. |
| Binary data | Version-dependent; test SDK fixture | `SEND_CHANNEL_DATA=62`, `CHANNEL_DATA_RECV=27` | Outbound raw datagrams denied until separately approved; inbound decoded only when supported. |
| Connection mode | Hardware TCP may accept only one | Firmware TCP replaces previous socket | Virtual service must support N isolated clients. |

**Version caution:** A protocol number is not a negotiated security permission; never automatically enable v14 commands because app says 14.

## Golden byte layouts and response semantics (v14 source)

Golden fixtures: [`tests/fixtures/virtual_companion_protocol_s01.json`](../tests/fixtures/virtual_companion_protocol_s01.json). All public keys, secrets, names, ACK tags, timestamps, battery/PIN fields and message contents are **synthetic**; these are **derived example bytes from source layouts**, not traffic captured from a live app/radio.

| Request/stream | Firmware source | Exact fields and implications |
|---|---|---|
| `CMD_DEVICE_QUERY=22` (min 2 bytes) → `DEVICE_INFO=13` | `MyMesh.cpp:1055-1075` | response code; firmware/protocol byte; max_contacts **half-unit**; max_group_channels; **4-byte PIN** (must not expose real PIN); 12-byte build date; 40-byte manufacturer; 20-byte firmware version; repeat-en flag; path hash mode. **82 bytes** overall. Advertise truthful virtual capabilities; sensitive fields require reviewed policy. |
| `CMD_APP_START=1` (min 8 bytes) → `SELF_INFO=5` | `MyMesh.cpp:1076-1117` | code, advert type, TX power, max power, **32-byte public key**, lat/lon int32 microdegrees LE, four 1-byte flags, freq and BW uint32 LE in kHz/hertz-scaled source units, SF and CR bytes, unpadded trailing name. **57 bytes before name.** Do not create a key; physical identity must be verified. |
| `CMD_GET_CONTACTS=4` plus optional **4-byte LE since** → START/CONTACT/END | `MyMesh.cpp:170-190,1238-1258,2388-2409` | START=`02 + uint32_le(total contacts)` (**not** filtered). Each CONTACT=`03 + full key32 + type1 + flags1 + pathlen1 + path64 + name32 + last_advert4 + lat4 + lon4 + lastmod4` (**148 bytes**). END=`04 + uint32_le(most_recent_lastmod)`. Firmware iterators are global: virtual ones must be per client and DB-backed. |
| `CMD_GET_CONTACT_BY_KEY=30` | `MyMesh.cpp:1371-1378` | full 32-byte key, returns CONTACT or `ERR_NOT_FOUND`. Never resolve an ambiguous short prefix to an invented identity. |
| `CMD_GET_CHANNEL=31` plus 1-byte **virtual** slot → CHANNEL_INFO | `MyMesh.cpp:1752-1766` | `12 + slot1 + name32 + channel_secret16` = **50 bytes**. This transmits channel **secrets** and must be within the explicitly authorized client trust boundary; never confuse physical radio slot index with virtual slot. A finite stable mapping is essential. |
| `CMD_SYNC_NEXT_MESSAGE=10` → V3 DM / channel / no more | `MyMesh.cpp:248-261,440-473,558-587,1415-1423` | V3 DM=`10 + snr_q4 int8 + reserved2 + sender_prefix6 + pathlen1 + txt_type1 + timestamp_u32le + [signed prefix4 if applicable] + UTF-8 text`. V3 channel=`11 + snr_q4 + reserved2 + channel_index1 + pathlen1 + txt_type1 + timestamp_u32le + text`. EOF=`0a`, MSG_WAITING push=`83`. Firmware `getFromOfflineQueue` **destructively removes** a frame: virtual cursor must NEVER call it. |
| `CMD_SEND_TXT_MSG=2` → SENT or ERR; ACK push | `MyMesh.cpp:1132-1177,422-431` | request=`02 + txt_type1 + attempt1 + timestamp_u32le + dest_prefix6 + text` (firmware requires len≥14). SENT=`06 + flood_flag1 + real_expected_ack4 + estimated_ms4` (**10 bytes**). Later ACK push=`82 + same_ack4 + trip_ms4` (**9 bytes**). **Do not fabricate an ACK code, successful TX or delivery.** S08 must get genuine job outcome from canonical service. |
| `CMD_SEND_CHANNEL_TXT_MSG=3` → OK or ERR | `MyMesh.cpp:1178-1197` | request=`03 + txt_type1 + virtual_slot1 + timestamp_u32le + text`. Only plain text; route to DB channel key, not physical slot. No automatic retransmission. |
| ERR / DISABLED | `MyMesh.cpp:153-168` | error=`01 + one byte`: UNSUPPORTED=1, NOT_FOUND=2, TABLE_FULL=3, BAD_STATE=4, FILE_IO=5, ILLEGAL_ARG=6. DISABLED=`0f` (one byte). **Exact UI reaction to each code must be probed using official clients**, not assumed. |

## Exhaustive source-defined command disposition (59 opcodes)

**A = proposed MESHRIK state read**, **B = candidate validated domain write** (only once S08/S09/S10 approves it), **C = explicitly denied by default**. **This table is not an already-active allowlist:** S02 starts with *every command denied* and layers explicitly enable only verified implementations. An A command with no verified cached state must report honest unsupported/unavailable, **never poll radio implicitly**. B does not imply permission to write the hardware; only already-authorized domain service. C MUST never fall through to `MeshCore.commands`.

Pending unsupported response contract: prefer firmware `RESP_CODE_ERR=1` + `ERR_CODE_UNSUPPORTED_CMD=1` (`01 01`); use `RESP_CODE_DISABLED=15` (`0f`) only when source semantics and released-app behavior justify it. No silently successful `OK`. **Final per-command error code is a S01 official-app trace acceptance gate.** Syntax/source numbers below are actual `MyMesh.cpp` defines.

| Opcode | Command | Policy | Reason / proposed adapter | Definition |
|---|---|:---:|---|---|
| `0x01` (1) | `CMD_APP_START` | **A** | SELF_INFO: verified managed Companion identity; zero radio commands | `MyMesh.cpp:9` |
| `0x02` (2) | `CMD_SEND_TXT_MSG` | **B** | Validated DM send through existing message service and radio worker | `MyMesh.cpp:10` |
| `0x03` (3) | `CMD_SEND_CHANNEL_TXT_MSG` | **B** | Validated TX via shared virtual channel mapping and worker | `MyMesh.cpp:11` |
| `0x04` (4) | `CMD_GET_CONTACTS` | **A** | DB snapshot with client-specific cursor and optional since | `MyMesh.cpp:12` |
| `0x05` (5) | `CMD_GET_DEVICE_TIME` | **A** | Host clock with compatible CURR_TIME reply | `MyMesh.cpp:13` |
| `0x06` (6) | `CMD_SET_DEVICE_TIME` | **C** | Disallow physical/shared clock mutations | `MyMesh.cpp:14` |
| `0x07` (7) | `CMD_SEND_SELF_ADVERT` | **C** | RF TX denied absent separate reviewed opt-in | `MyMesh.cpp:15` |
| `0x08` (8) | `CMD_SET_ADVERT_NAME` | **C** | Disallow shared node identity mutation | `MyMesh.cpp:16` |
| `0x09` (9) | `CMD_ADD_UPDATE_CONTACT` | **B** | Potential validated DB-only contact mutation; not radio contact list | `MyMesh.cpp:17` |
| `0x0a` (10) | `CMD_SYNC_NEXT_MESSAGE` | **A** | Virtual per-client DB message cursor; NEVER firmware queue | `MyMesh.cpp:18` |
| `0x0b` (11) | `CMD_SET_RADIO_PARAMS` | **C** | Physical radio configuration forbidden | `MyMesh.cpp:19` |
| `0x0c` (12) | `CMD_SET_RADIO_TX_POWER` | **C** | Physical power change forbidden | `MyMesh.cpp:20` |
| `0x0d` (13) | `CMD_RESET_PATH` | **C** | Mutating route policy not authorized in first release | `MyMesh.cpp:21` |
| `0x0e` (14) | `CMD_SET_ADVERT_LATLON` | **C** | Shared node config change forbidden | `MyMesh.cpp:22` |
| `0x0f` (15) | `CMD_REMOVE_CONTACT` | **B** | Potential validated DB-only contact delete | `MyMesh.cpp:23` |
| `0x10` (16) | `CMD_SHARE_CONTACT` | **C** | RF transmit command denied | `MyMesh.cpp:24` |
| `0x11` (17) | `CMD_EXPORT_CONTACT` | **C** | Avoid unauthorized signed packet/contact export | `MyMesh.cpp:25` |
| `0x12` (18) | `CMD_IMPORT_CONTACT` | **B** | Potential verified MESHRIK DB import without radio writes | `MyMesh.cpp:26` |
| `0x13` (19) | `CMD_REBOOT` | **C** | Physical radio reboot forbidden | `MyMesh.cpp:27` |
| `0x14` (20) | `CMD_GET_BATT_AND_STORAGE` | **A** | Only cached verified telemetry; unavailable must be honest | `MyMesh.cpp:28` |
| `0x15` (21) | `CMD_SET_TUNING_PARAMS` | **C** | Physical radio tuning forbidden | `MyMesh.cpp:29` |
| `0x16` (22) | `CMD_DEVICE_QUERY` | **A** | DEVICE_INFO with virtual capabilities and correct protocol | `MyMesh.cpp:30` |
| `0x17` (23) | `CMD_EXPORT_PRIVATE_KEY` | **C** | Never export managed radio private key | `MyMesh.cpp:31` |
| `0x18` (24) | `CMD_IMPORT_PRIVATE_KEY` | **C** | Never replace managed radio private key | `MyMesh.cpp:32` |
| `0x19` (25) | `CMD_SEND_RAW_DATA` | **C** | Arbitrary RF data blocked | `MyMesh.cpp:33` |
| `0x1a` (26) | `CMD_SEND_LOGIN` | **C** | RF login needs separately authorized response-tracker integration | `MyMesh.cpp:34` |
| `0x1b` (27) | `CMD_SEND_STATUS_REQ` | **C** | Implicit RF status query blocked | `MyMesh.cpp:35` |
| `0x1c` (28) | `CMD_HAS_CONNECTION` | **A** | Cache-backed answer only if meaningful; otherwise error | `MyMesh.cpp:36` |
| `0x1d` (29) | `CMD_LOGOUT` | **C** | Cannot change physical RF session via arbitrary TCP client | `MyMesh.cpp:37` |
| `0x1e` (30) | `CMD_GET_CONTACT_BY_KEY` | **A** | MESHRIK DB full-key lookup | `MyMesh.cpp:38` |
| `0x1f` (31) | `CMD_GET_CHANNEL` | **A** | Shared finite virtual slots from DB, never physical slots | `MyMesh.cpp:39` |
| `0x20` (32) | `CMD_SET_CHANNEL` | **C** | Never directly mutate physical channel slots | `MyMesh.cpp:40` |
| `0x21` (33) | `CMD_SIGN_START` | **C** | General private-key signing oracle forbidden | `MyMesh.cpp:41` |
| `0x22` (34) | `CMD_SIGN_DATA` | **C** | General private-key signing oracle forbidden | `MyMesh.cpp:42` |
| `0x23` (35) | `CMD_SIGN_FINISH` | **C** | General private-key signing oracle forbidden | `MyMesh.cpp:43` |
| `0x24` (36) | `CMD_SEND_TRACE_PATH` | **C** | RF tracing requires a separately reviewed domain operation | `MyMesh.cpp:44` |
| `0x25` (37) | `CMD_SET_DEVICE_PIN` | **C** | Physical BLE/device access change forbidden | `MyMesh.cpp:45` |
| `0x26` (38) | `CMD_SET_OTHER_PARAMS` | **C** | Physical configuration change forbidden | `MyMesh.cpp:46` |
| `0x27` (39) | `CMD_SEND_TELEMETRY_REQ` | **C** | RF telemetry query needs reviewed domain operation | `MyMesh.cpp:47` |
| `0x28` (40) | `CMD_GET_CUSTOM_VARS` | **C** | Firmware-specific state not represented by MESHRIK DB | `MyMesh.cpp:48` |
| `0x29` (41) | `CMD_SET_CUSTOM_VAR` | **C** | Firmware-specific mutation forbidden | `MyMesh.cpp:49` |
| `0x2a` (42) | `CMD_GET_ADVERT_PATH` | **A** | Cached observed path only; otherwise not found/unsupported | `MyMesh.cpp:50` |
| `0x2b` (43) | `CMD_GET_TUNING_PARAMS` | **A** | Cached verified state only, no new physical read | `MyMesh.cpp:51` |
| `0x32` (50) | `CMD_SEND_BINARY_REQ` | **C** | Unaudited RF command blocked | `MyMesh.cpp:53` |
| `0x33` (51) | `CMD_FACTORY_RESET` | **C** | Physical destructive reset forbidden | `MyMesh.cpp:54` |
| `0x34` (52) | `CMD_SEND_PATH_DISCOVERY_REQ` | **C** | RF discovery needs separately reviewed domain operation | `MyMesh.cpp:55` |
| `0x36` (54) | `CMD_SET_FLOOD_SCOPE_KEY` | **C** | Physical/shared flood scope change forbidden | `MyMesh.cpp:56` |
| `0x37` (55) | `CMD_SEND_CONTROL_DATA` | **C** | Arbitrary RF control command blocked | `MyMesh.cpp:57` |
| `0x38` (56) | `CMD_GET_STATS` | **A** | Cached trustworthy statistics only; no physical polling | `MyMesh.cpp:58` |
| `0x39` (57) | `CMD_SEND_ANON_REQ` | **C** | Anonymous RF request not authorized | `MyMesh.cpp:59` |
| `0x3a` (58) | `CMD_SET_AUTOADD_CONFIG` | **C** | MESHRIK owns hardware contact offload policy | `MyMesh.cpp:60` |
| `0x3b` (59) | `CMD_GET_AUTOADD_CONFIG` | **A** | Return cached managed policy or explicit unsupported | `MyMesh.cpp:61` |
| `0x3c` (60) | `CMD_GET_ALLOWED_REPEAT_FREQ` | **A** | Cache-backed capability only, else unsupported | `MyMesh.cpp:62` |
| `0x3d` (61) | `CMD_SET_PATH_HASH_MODE` | **C** | Physical path-hash mode forbidden | `MyMesh.cpp:63` |
| `0x3e` (62) | `CMD_SEND_CHANNEL_DATA` | **C** | Binary/datagram TX not in initial allowlist | `MyMesh.cpp:64` |
| `0x3f` (63) | `CMD_SET_DEFAULT_FLOOD_SCOPE` | **C** | Shared radio policy change forbidden | `MyMesh.cpp:65` |
| `0x40` (64) | `CMD_GET_DEFAULT_FLOOD_SCOPE` | **A** | Cached managed scope or explicit unsupported | `MyMesh.cpp:66` |
| `0x41` (65) | `CMD_SEND_RAW_PACKET` | **C** | Arbitrary raw packet transmission forbidden | `MyMesh.cpp:67` |
| `0x42` (66) | `CMD_RUN_CLI_COMMAND` | **C** | Protocol14 CLI is not a client privilege | `MyMesh.cpp:68` |

Numbers `44–49` are reserved for Wi-Fi operations; `53` is absent. Unknown future opcodes are **C/denied** until reviewed. Error/push/response code lists are source-defined separately in `MyMesh.cpp:75–141` and must never be accepted as client command codes.

## Design handoff to S02–S13

- **S02** framing and per-client session/writer with default-deny dispatch: no production listener; bounds, EOF, timeouts, no second meshcore instance.
- **S03** singleton integration `virtual_companion_tcp` config using existing fanout CRUD/lifecycle (inbound listener is a dedicated module, not JSON WebSocket/MQTT subscriber), OFF by default, restricted bind, no assumption HTTP Basic applies.
- **S04** SELF_INFO/DEVICE_INFO from verified cached radio identity. Physical generation change fences old sessions; PIN/private key never revealed without explicit review.
- **S05–S07** DB contact snapshots and durable lastmod revision decision; stable finite virtual channel slots; distinct client message cursors and push notifications. Never consume hardware queue.
- **S08–S10** typed and validated DM/channel sends via existing `app/services/message_send.py` and single `radio_job_worker`, no RF retry on ambiguous/unknown outcome; explicit audited DB mutations, privileged commands blocked.
- **S11–S13** settings UI, false-success/timeout/race tests, official app transcripts, threat model and operator docs. Parent issues [#224–#237](https://github.com/Bjorkan/MESHRIK/issues/224).

### Hardware-free S01 quality gate

```sh
uv run pytest -q -n 0 tests/test_virtual_companion_protocol_contract.py tests/test_companion_protocol_118.py
uv run ruff check tests/test_virtual_companion_protocol_contract.py
```

`pytest` uses synthetic wire examples. It proves only layout/manifest checks, **not** that official released apps accept the emulation. This PR intentionally contains **no runtime TCP listener, config changes, RF commands, private keys, network sockets or production UI changes**. S01 should stay **draft/blocked for app-capture acceptance** if actual released-app trace evidence has not been collected.
