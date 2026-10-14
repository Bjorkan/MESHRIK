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
