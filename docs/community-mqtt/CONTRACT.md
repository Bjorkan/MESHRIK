# Community MQTT compatibility contract (#109)

These integrations are **opt-in** and are separate from private MQTT (`app/mqtt.py`).
Broker-specific namespaces, authentication and topic permissions must not be
silently shared. The broker, rather than observer firmware, defines its policy.
A QoS 0 `publish()` return means only local client submission; rejection can
arrive later on the observer's own `/error` subscription.

MESHRIK owns exactly one Companion connection/radio command worker. Companion
protocol 13 provides RX raw frames, but **not** an authoritative native
repeater neighbor-table dump or individually verified on-air TX raw events.
A host-observed neighbor subset must be labeled as such; it cannot be expanded
from contact prefixes or remote repeater tables. Discovery commands require
operator consent, admission limits and safety with respect to contact storage.

An observer upload must never include decrypted message text, exported private
keys, JWTs, passwords, private scope keys or credential-bearing MQTT topic names
in status/error messages. Device-side signing is not private-key export and
cannot be used to decrypt historical direct messages.

#108 (global startup mode) is a separate prerequisite and is **not** changed by
this patch series. Changes must be reviewed with this boundary intact.

## Applying the patch series

The issue-numbered commits are incremental. Apply `109` then `110`, ... `123`
in numeric order with `git am`. Patches are not individually applicable against
the initial checkout. Issue 109 is a contract/architecture tracking issue;
subsequent patches own the corresponding implementations.

## Companion neighbor data matrix (#113)

| Field | Provenance | Completeness |
| --- | --- | --- |
| Full neighbor key and type | Tagged `DISCOVER_RESPONSE`, zero-hop | Only responding repeaters/sensors |
| Local SNR/RSSI, remote SNR | Same discovery response | Only actually supplied values |
| Last heard | MESHRIK host ingest clock | Not firmware RF timestamp |
| Flood-allowed scopes | Explicit guest region query on a repeater | Only queried/responding repeaters; guest query may add radio contact |
| Own default scope | GET_DEFAULT_FLOOD_SCOPE 64 | Optional name; never publish its key |
| Own full installed scopes | Not exported by Companion protocol 13 | Unknown; omit `self.scopes` |
| Native zero-hop table, authentic TX frames | Not exported by Companion | Unsupported |

The existing `POST /radio/discover` writes full-key observations; the manual
`POST /radio/discover-regions` enriches already-observed repeaters. Automatic
RF discovery and unattended guest scope queries must **not** be enabled until
a contact-write-free worker-safe implementation is proven. Scheduled neighbor
publications currently use the existing recent observation snapshot only.
Rows expire from snapshots after 48 hours without another host observation.
The `sample_type=host_observed_nearby` extension prevents treating these
counts as a complete firmware neighbor table.

## TX limitation (#116)

Stock Companion protocol 13 pushes RX_LOG_DATA=0x88 with physical received
packet bytes and local signal measurements. It does **not** push exact raw TX
packet bytes with individual transmission confirmation. CMD_SEND_RAW_PACKET=65
success means accepted into the device's send queue, not on-air success.
Aggregated GET_STATS TX counters cannot reconstruct frames. Thus the TX mode
setting remains disabled by capability on this firmware even when the operator
chooses `on`/`advert`. No TX HTTP sends are intercepted or reconstructed.
