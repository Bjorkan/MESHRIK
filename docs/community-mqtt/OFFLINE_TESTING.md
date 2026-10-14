# Offline MQTT wire contract and smoke procedure (#121)

Run `pytest tests/test_community_contract_110.py tests/test_community_contract_121.py` without broker credentials or a second radio. Checked-in `tests/fixtures/community_mqtt/*.json` describe sanitized observer packet/status and the Companion **host-sampled** neighbor subset. Never upload real radio traffic during CI. These are shape/queue/router unit tests, not a claim of broker integration or physical radio tests.

## Optional single-node smoke procedure (operator-authorized)

1. Back up your local configuration, connect one authorized Companion, and verify that its public key matches your configured observer identity.
2. Confirm packet sharing is explicitly enabled and you own the broker/ingress credentials. Leave neighbor refresh and TX off initially.
3. Test a broker error subscription with synthetic diagnostic JSON; inspect only error code, timestamp and remedy. Never print full token-bearing topics.
4. Disconnect just the MQTT broker (not Companion), supply controlled sample RX observations, reconnect and confirm queue counters and preserved host receive timestamps.
5. If neighbor sharing is separately authorized, request one low-priority discovery sweep with a known safe radio contact policy and confirm the broker receives only recently host-observed full public keys. There is no complete Companion radio neighbor table.
6. Check private MQTT functionality independently. No second radio and no production RF uplink is required for the automated acceptance checks.

Firmware compatibility: Companion protocol 13 exposes RX log bytes (signed RSSI, SNR byte / 4), three GET_STATS subtypes, DEVICE_INFO repeat flag, SIGN_START/DATA/FINISH, and control-node discovery. It does **not** export the full native neighbor table or per-frame TX log. #122 independently covers signing-only JWT auth; #123 independently covers CONTACT_DELETED/CONTACTS_FULL push reconciliation.
