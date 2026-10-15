# Incident #156 — RF observation to application visibility

This document coordinates #138–#155, #157–#159. Each patch owns its own
failure mechanism; applying #156 does **not** imply the linked issues are closed.

| Stage | Observation available | Failure boundary | Operator response |
| --- | --- | --- | --- |
| RF demodulation | Companion firmware counters (aggregate only) | A peer hearing RF does not prove this radio did | Compare independent observations; never infer dropped count |
| Firmware offline queue | Reconnect gap, surviving queued payloads | Oldest channel entries can be evicted | Check transport stability; count loss as unknown |
| SDK response | Worker-owned `get_msg` + one response waiter | SDK background auto-fetch can compete | Never re-enable `start_auto_message_fetching()` |
| Host staging | `pending_radio_ingress` unresolved/stored | SQLite outage/unknown channel slot | Retry quarantine only after independent identity proof |
| Raw ingestion | `rx_ingress.snapshot()` | Bounded queue overflow or parse error | Inspect counters without transmitting RF |
| Chat commit | `messages` + `raw_packets` link | Packet identity vs text/second collision | Prefer canonical wire identity |
| Browser handoff | Per-client websocket outboxes | Slow browser, interrupted socket | Reconnect and refetch canonical REST messages |
| TX command | Outgoing `pending/confirmed/unknown` | Accepted by firmware is NOT peer delivery | Do not automatically resend ambiguous sends |
| ACK | `pending_dm_ack_correlations` | Commit failure/restart | Replay ACK only against matching radio identity |

## Privacy

Do not send decrypted DMs/channel text, channel transport secrets, radio private
keys or ACK correlation codes to external metrics/logs. Record bounded counters,
error categories, queue ages and connection windows instead. Use fake Companion
frames and local SQLite for regression, never mandatory two-radio testing.

## Recovery limitations

Firmware v13 does not expose its complete raw RF history or the exact number
of offline queue evictions. Historical queued channel_idx does not prove the
identity of a slot after reuse; leave ambiguous content in private quarantine.
A timed-out TX command may have been accepted; keep its audit record and
require explicit operator consent for retransmission. This report does not
claim that any specific incident was caused by one of these code paths.
