# Virtual TCP Companion: protocol contract and implementation decisions

> **Status: implemented through S09 on an unmerged stack.** The listener remains disabled by default and the complete S01–S13 stack must pass its release gate before merge. See epic [#224](https://github.com/Bjorkan/MESHRIK/issues/224).

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
| `CMD_APP_START=1` (min 8 bytes) → `SELF_INFO=5` | `MyMesh.cpp:1076-1117` | code, advert type, TX power, max power, **32-byte public key**, lat/lon int32 microdegrees LE, four 1-byte flags, freq and BW uint32 LE in kHz/hertz-scaled source units, SF and CR bytes, unpadded trailing name. **58 bytes before name.** Do not create a key; physical identity must be verified. |
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

### Implemented S04 version and identity policy

The virtual `DEVICE_INFO` protocol byte is `min(physical cached protocol, 14)` and requires a
verified physical protocol of at least 13. The client's `DEVICE_QUERY` target is retained only in
that client's session and cannot raise the advertised virtual version or change another session.
`SELF_INFO` is encoded solely from the current connected generation's already-loaded `self_info`;
missing identity/device metadata returns `ERR_CODE_BAD_STATE`. Generation changes disconnect all
virtual sessions. The physical BLE PIN is emitted as zero and private-key/signing commands remain
unsupported. Time, battery and statistics requests remain default-denied in S04 because no released
native-app trace has established that they are required; a later layer may expose only existing
cache values, never trigger a radio poll during handshake.

### Implemented S05 contact snapshot policy

`GET_CONTACTS` and `GET_CONTACT_BY_KEY` read one transactionally consistent MESHRIK database
snapshot and never enumerate the physical radio. Stable ordering is by normalized full public key;
prefix-only, malformed, and case-ambiguous identities are withheld rather than padded or guessed.
The START count is the complete eligible catalog size even when `since` filters the emitted rows.

A durable SQLite clock assigns a monotonic 32-bit-compatible revision to every contact insert,
update, or delete. END reports the snapshot high-water revision. Incremental requests return current
rows changed after `since` plus firmware-compatible `CONTACT_DELETED` tombstone pushes; tombstones
are retained so reconnecting clients cannot silently miss a web/API deletion. A `since=0` first sync
returns the current catalog without historical tombstones. Each request owns its immutable snapshot,
and multi-frame replies enter the existing bounded per-session writer queue with backpressure, so
one client's enumeration cannot consume or interrupt another client's stream.

### Implemented S06 virtual channel policy

`GET_CHANNEL` resolves an operator-selected, persisted virtual slot list against the current
MESHRIK channel database. The default advertised capacity is 40 slots and can be configured from 1
to 255; `DEVICE_INFO.max_channels` reports that virtual capacity rather than the physical radio's
temporary slots. Slot entries may be deliberately empty, are never compacted, and are shared by all
clients. A missing/deleted channel therefore returns `ERR_CODE_NOT_FOUND` without allowing a newly
created channel to inherit the stale slot. A configuration remap uses the integration lifecycle to
disconnect old sessions before the replacement mapping accepts clients.

Each successful reply is exactly `CHANNEL_INFO + slot + name[32] + secret[16]`. The read path selects
only `channels.key` and `channels.name`; it neither consults radio-residency caches nor invokes a
physical GET/SET_CHANNEL or worker job. Operational status reports only capacity and configured-slot
count, never channel secrets. Later outbound channel sends must resolve through the typed virtual
slot object again and reject stale mappings before entering the canonical send service.

### Implemented S07 virtual message queues

`SYNC_NEXT_MESSAGE` reads only committed incoming `messages` rows and never calls the physical
firmware queue. Each TCP session owns a monotonically increasing database-ID cursor, so EOF and
interleaved reads cannot drain another client. A new or reconnected session starts immediately
before its newest 200 accessible rows; this bounded replay window makes reconnect deterministic
without claiming durable per-app identity. It then follows new rows without a page-size ceiling.
Only full-key contacts still present in the contact catalog and channels assigned to current stable
virtual slots are eligible. Deletions and retention gaps are skipped naturally.

Replies use the negotiated Companion layout: V3 `CONTACT_MSG_RECV`/`CHANNEL_MSG_RECV` frames include
retained SNR and path-status evidence, while legacy layouts are emitted only for an explicitly
negotiated pre-V3 context. Missing evidence is represented by neutral SNR and the protocol's
unavailable/direct path marker; no RF path or full sender key is synthesized. Signed room posts keep
the room contact's six-byte conversation prefix and their separately stored four-byte author prefix.
Only decrypted text rows are exposed, and UTF-8 payloads are truncated on character boundaries.

After persistence, canonical realtime message broadcasts send a content-free `MSG_WAITING` hint to
each current virtual session independently of fanout content scopes. Hints coalesce until that client
requests its next message. Per-client output remains bounded; queue overflow or write timeout closes
only the slow socket, while database storage and healthy clients continue. Radio-generation changes
retain the existing session fence and disconnect every stale cursor.

### Implemented S08 direct-message send policy

`SEND_TXT_MSG` accepts only the exact bounded firmware frame, strict UTF-8 without embedded NUL,
`TXT_TYPE_PLAIN`, attempt zero, a bound radio-generation identity and an unambiguous six-byte prefix
for a current full-key contact. CLI types, client retries, malformed frames and missing, prefix-only or
ambiguous contacts fail before entering a send service. The app-provided uint32 timestamp is retained
as the requested sender timestamp.

Accepted requests call the existing scheduler-backed `send_direct_message_to_contact` workflow. That
workflow still stages the effective contact route, commits one pending outgoing database row before
RF, uses the single radio worker and applies the canonical ACK tracker. Its web/API return remains
unchanged; an opt-in sanitized result exposes only the genuine firmware route flag, four-byte ACK tag
and uint32 suggested timeout needed for the exact ten-byte `SENT` response. Missing, malformed,
rejected, timed-out and uncertain radio results return an error and never synthesize `SENT`.

Virtual sends disable the domain service's background retry for this entry point. A shared,
generation-scoped single-flight key of full contact, original timestamp and text makes concurrent
clients join one operation. Up to 512 completed results are retained for lost-reply reconnects; after
eviction, the durable outgoing row rejects the duplicate rather than transmitting again. TCP
disconnect cannot cancel an operation already handed to the worker.

Each session records only ACK tags actually returned to that session. A host `SEND_CONFIRMED` event
is pushed as exact `0x82 + tag[4] + trip_time_ms[4]` only after the existing ACK pipeline has committed
the matching row. Other sessions do not receive the tag. An early genuine host ACK retains its real
trip time through canonical buffering and is returned immediately after `SENT`; raw ACK evidence
without host timing can update shared delivery state but cannot fabricate a Companion timing frame.

### Implemented S09 channel-text send policy

`SEND_CHANNEL_TXT_MSG` accepts only the exact bounded firmware frame, strict non-empty UTF-8 without
embedded NUL, `TXT_TYPE_PLAIN`, a bound radio identity and a current stable S06 virtual slot. The
slot is resolved first to its configured key and then to the current full channel row, including its
persisted flood-scope and path-hash overrides. Missing, deleted, stale and out-of-range slots never
enter a radio service. Channel datagrams remain a distinct default-denied command.

The adapter passes the DB channel/key to `send_channel_message_to_channel` with the app's exact
uint32 sender timestamp and a physical-slot *preference of zero*, never the virtual index. The
canonical service alone plans/loads/restores temporary physical slots and regional/hash-mode state
inside the single worker. It commits and broadcasts one outgoing row before/after the RF boundary as
already defined by the web send workflow. `OK` is returned only after that workflow receives a
non-error firmware response; reject, timeout and uncertain outcomes return an error and never claim
delivery or create an ACK.

Concurrent identical commands share a generation-scoped in-memory operation. A 24-hour SQLite
reservation keyed by public radio identity, virtual index, sender timestamp and SHA-256 text digest
survives process restart and virtual-slot remap without storing message text or channel secrets.
Thus a lost reply cannot be replayed onto a newly mapped channel, while equal text/timestamps on two
different virtual indices remain distinct. Completed/uncertain operations are not retransmitted;
safe pre-dispatch queue/disconnect failures release their reservation and may be retried. Exact
timestamp mode also rejects a concurrent collision instead of silently changing the app's identity.

### Hardware-free S01 quality gate

```sh
uv run pytest -q -n 0 tests/test_virtual_companion_protocol_contract.py tests/test_companion_protocol_118.py
uv run ruff check tests/test_virtual_companion_protocol_contract.py
```

`pytest` uses synthetic wire examples. It proves only layout/manifest checks, **not** that official released apps accept the emulation. This PR intentionally contains **no production TCP listener, no runtime config changes, RF commands, private keys, network sockets or production UI changes**. S01 should stay **draft/blocked for app-capture acceptance** if actual released-app trace evidence has not been collected.
