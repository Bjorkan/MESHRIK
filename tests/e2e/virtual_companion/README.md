# Virtual Companion release-gate harness

Run the required hardware-free SDK smoke test from the repository root:

```bash
PYTHONPATH=. uv run python tests/e2e/virtual_companion/harness.py
```

It starts a loopback-only synthetic Companion endpoint, connects two clients through the exact
`meshcore==2.3.16` dependency pinned by MESHRIK, and proves both sessions observe the same public
identity. It neither opens a physical transport nor transmits RF.

The broader required proof suite is included in the standard backend run and can be selected with:

```bash
PYTHONPATH=. uv run pytest tests/test_virtual_companion_*.py -q
```

## Automated coverage map

| Release risk | Deterministic proof |
| --- | --- |
| Firmware v13/v14 and binary framing drift | `test_virtual_companion_protocol_contract.py`, source-derived golden fixture, and the S12 all-opcode TCP test |
| Real Python SDK interoperability | S12 `meshcore==2.3.16` two-client test and this standalone harness |
| Per-client isolation, 8-client reconnect, slow client, 10k burst | `test_virtual_companion_transport.py`, `test_virtual_companion_messages.py`, and `test_virtual_companion_security_e2e.py` |
| ACK ownership, replay, timeout, ambiguous result, no duplicate RF | `test_virtual_companion_direct_send.py` and `test_virtual_companion_channel_send.py` |
| Identity replacement and mixed generations | `test_virtual_companion_identity.py` and generation-scoped send tests |
| Worker busy/quarantine/disconnect behavior | direct/channel send tests using the canonical radio scheduler seam |
| All command bytes, forbidden privileges, no generic SDK dispatch | `test_virtual_companion_command_policy.py` and S12 physical-access tripwires |
| Listener policy, singleton, default OFF, port collision, rollback | `test_virtual_companion_integration.py` and S12 restart soak |
| Malformed/truncated/oversized frames and bounded queues | transport framing tests plus S12 malformed-peer and burst tests |
| Secret/log hygiene | synthetic-only fixtures and the S12 denied-payload log assertion |

All physical-send proof remains at the single existing scheduled service seam. The listener,
handshake, list, sync, contact mutation, and denied-command paths have no radio/SDK dispatcher.

## Post-merge Android/iOS and managed-radio validation

This validation is intentionally performed only after the complete stack has merged; it is not a
pre-merge requirement. No Android or iOS binary, device, OS version, or operator-supervised radio is
used in deterministic CI. Source-derived fixtures and `meshcore_py` interoperability are not
represented as mobile-app or physical-radio captures.

Before claiming released mobile compatibility, record a sanitized transcript and screenshots for
both rows and perform the supervised managed-radio checks.
Never record a private key, channel secret, message text, host IP, BLE PIN, or real peer address.

| Platform | App version | OS/device | Two clients | Required checks | Evidence |
| --- | --- | --- | --- | --- | --- |
| Android official app | pending | pending | pending | connect, same identity twice, contacts/channels, incoming DM/channel, sends/ACK, reconnect, bad endpoint, unsupported actions | post-merge pending |
| iOS official app | pending | pending | pending | connect, same identity twice, contacts/channels, incoming DM/channel, sends/ACK, reconnect, bad endpoint, unsupported actions | post-merge pending |

Use MESHRIK's virtual bind address and port, never the physical Companion endpoint. Start with a
fake/controlled backend. An optional managed-radio smoke must be explicitly supervised and must not
perform unattended RF. If either app demands private-key transfer or cannot use a custom TCP
endpoint, keep the feature release-blocked and record that behavior verbatim without entering a key.
