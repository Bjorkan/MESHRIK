# MeshCore Companion 1.18.0 / Python SDK 2.3.16

This compatibility series implements GitHub issues #160–#168. It is based on
actual firmware 1.18 source and the supplied `meshcore_py-main` tree (version
2.3.16). It does **not** require a second physical radio.

## Capability and source matrix

| Feature | Companion protocol 13 (1.17.1) | Protocol 14 (1.18.0) | MESHRIK behavior |
|---|---|---|---|
| Basic DEVICE_INFO, RX_LOG_DATA, contacts, messages, stats | Supported | Supported | Existing single worker preserved |
| Local CLI opcode 66 / reply 29 | Not supported | Supported | Fixed allowlist `get radio`, `get cad`, `get radio.rxgain`, `get agc.reset.interval`; never arbitrary input |
| Remote Companion CLI text type 3 | Not assumed | Supported with remote permission flag 0x10 | Operator opt-in, read-only fixed commands, RF send result is **not proof of execution** |
| Queued channel binary receive 27 | Supported | Supported | SDK 2.3.16 recognizes it in `get_msg()`; host records opaque binary in bounded SQLite journal |
| Binary channel data send 62 | Supported | Supported | Explicit consent and verified channel slot; developer namespace 0xFF00–0xFFFF only |
| Radio presets from official API | N/A | N/A | Optional suggested values, bundled offline fallback; never auto-apply or retune |
| CAD/RX gain/AGC | Hardware dependent | Protocol-14 local CLI access | Typed read-only snapshots; unknown values remain null |
| Native complete neighbor-table dump | Not available | Not available in audited source | Do not invent physical neighbors |
| Authentic per-frame TX event | Not available | Not available in audited source | Do not claim successful RF emission from command OK |

References: `MeshCore-main/examples/companion_radio/MyMesh.cpp`, `MyMesh.h`,
`src/helpers/CommonRadioPrefs.cpp`, `docs/companion_protocol.md`,
`docs/radio_presets.md`; `meshcore_py-main/src/meshcore/commands/messaging.py`,
`device.py`, `reader.py`.

## Privacy and safety

- Local CLI and diagnostics require protocol >=14; commands are exact pre-reviewed
  literals. Unrestricted `set`, key, WiFi password, reset and erase are denied.
- Remote CLI is an RF operation with one worker; no automatic retry occurs when
  the outcome is unknown. Remote permissions are enforced **by the recipient**.
  The application cannot infer remote authorization from command queue admission.
- `txt_type=3` represents a CLI command, never DM chat. CLI responses are also
  isolated. No commands enter notifications, private MQTT or Community MQTT.
- Binary channel datagrams have a **historic slot index**, not a cryptographic
  channel identity. Records stay unresolved in `companion_channel_datagrams`
  even if that slot now contains a different channel. Binary data is not
  automatically interpreted, rebroadcast or treated as text.
- The binary journal is memory-independent SQLite data with an upper bound of
  4,096 entries. Identical payload/type/slot bytes are conservatively deduped;
  that is not a guarantee of universal on-air frame identity. If the journal
  cannot commit, the event is *not* recorded as successfully staged. A
  firmware-side offline queue is still lossy under overflow (#151).
- Dynamic presets are obtained from a **fixed**, official HTTPS URL with no
  redirects, short timeout, 64 KiB body cap, bounded cache and strict numeric
  validation. Never change the connected radio merely by selecting a preset.
- `meshcore==2.3.16` in `pyproject.toml` and its verified PyPI SHA-256 release
  artifacts are pinned in `uv.lock`. Refresh the lock only through the normal
  trusted package resolver when online.

## Hardware-independent gate

From a clean project environment with `meshcore==2.3.16`:

```sh
uv sync --locked
uv run pytest -q tests/test_companion_protocol_118.py tests/test_companion_cli_118.py \
  tests/test_companion_cli_type_118.py tests/test_companion_datagrams_118.py \
  tests/test_companion_binary_tx_118.py tests/test_remote_companion_cli_118.py \
  tests/test_advanced_diagnostics_118.py tests/test_radio_presets_118.py
uv run ruff check app tests
```

Additionally run project-wide backend/static/frontend quality checks before
production deployment. See #138–#159 for separate receive/retry and ACK fixes.

## Optional one-radio smoke checklist

1. Confirm Companion firmware explicitly reports v1.18/protocol 14 and the
   MESHRIK worker has a single connected transport.
2. Query only `get cad` and `get radio`; confirm no private keys/PINs or
   credential strings appear in server logs or UI.
3. Verify firmware 13 reports unsupported for local CLI (no fallback RF send).
4. Opt in to one developer-namespace binary datagram **only** in a controlled
   network after verifying current channel residency and scope. `accepted_by_radio`
   means firmware accepted the command; it is not a peer delivery acknowledgment.
5. Verify offline radio preset fallback without applying values. Check that
   read-only advanced stats return null when the board lacks a feature.
6. Inspect queue/drop diagnostics from #138–#159 separately; no comparison
   radio or two-device end-to-end traffic is required.
