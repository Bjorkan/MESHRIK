# Companion RX/TX reliability boundaries

Stock Companion protocol 13 reports incoming raw RF packets but no trustworthy
per-frame transmitted bytes or completion event. A local command OK means
queue acceptance, **not** peer delivery. Channel echoes may be delayed by
LoRa airtime, multihop, and duty-cycle. The legacy auto-resend option is
intentionally observation-only until safe per-frame TX evidence is available;
retransmit only by an explicit operator action, with duplicate-send risk.

Queued Companion messages may be evicted while the transport is disconnected;
MESHRIK can recover surviving queue items but not infer missing RF frames.

## Queued channel slot identity

A queued Companion CHANNEL_MSG_RECV has its original slot number, not its
channel secret. Once slot residency can change, current `get_channel(slot)`
cannot prove the historic conversation. Unattested entries remain in the
persistent `pending_radio_ingress` quarantine instead of leaking plaintext
into another channel. Reprocessing is permitted only with an independently
verified complete 16-byte channel identity from the same RX observation.
This conservative safety rule can leave genuine old messages unresolved.

## Firmware queue overflow visibility

Companion may evict the oldest queued channel item if its offline buffer
fills. There is no trustworthy firmware eviction counter via Companion v13.
Health `rx_coverage.drop_count=null` means **unknown**, never zero. The
transport disconnect interval is recorded as a possible data-loss window;
receiving all surviving items does not establish uninterrupted RF coverage.

## Radio worker quarantine

`/health.radio_scheduler` distinguishes strict restart-only quarantine from
cooperatively cancelled read-only commands potentially recoverable after a
**new transport generation**. Recovery is an explicit method, not a replay:
mutating sends, unresponsive tasks and same-generation requests cannot reset
the fence. Never infer peer delivery from scheduler recovery.
