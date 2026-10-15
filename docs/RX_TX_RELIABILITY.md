# Companion RX/TX reliability boundaries

Stock Companion protocol 13 reports incoming raw RF packets but no trustworthy
per-frame transmitted bytes or completion event. A local command OK means
queue acceptance, **not** peer delivery. Channel echoes may be delayed by
LoRa airtime, multihop, and duty-cycle. The legacy auto-resend option is
intentionally observation-only until safe per-frame TX evidence is available;
retransmit only by an explicit operator action, with duplicate-send risk.

Queued Companion messages may be evicted while the transport is disconnected;
MESHRIK can recover surviving queue items but not infer missing RF frames.
