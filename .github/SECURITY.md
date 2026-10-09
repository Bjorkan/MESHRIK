# Security policy

MESHRIK is intended for **trusted environments**. It provides privileged management of a MeshCore radio and can run user-configured Python bots. Do not expose an MESHRIK instance directly to an untrusted network. Refer to the [README](../README.md) for deployment and security considerations.

## Supported versions

Security fixes are generally considered for the **latest published release**. Maintenance of older releases, development builds, and third-party packaging is not guaranteed. When reporting an issue, specify your installed version or commit so maintainers can evaluate applicability.

## Reporting a vulnerability

**Do not open a public issue containing vulnerability details, exploits, credentials, or private radio/network data.**

1. If GitHub private vulnerability reporting is enabled, use the repository's [Security advisories](https://github.com/Bjorkan/MESHRIK/security/advisories) and select **Report a vulnerability**.
2. Explain the affected versions, reproduction conditions, security impact, and any safe proof of concept. Include only sanitized logs and configuration examples.
3. If private vulnerability reporting is not available, open a **non-sensitive public issue requesting a private contact method**, without revealing technical details of the vulnerability. Wait for maintainers to provide a secure channel before sharing details.

Do not include private keys, passwords, tokens, channel keys, user messages, or identifiable radio traffic. Do not test or transmit on radios, servers, or mesh networks you do not own or have permission to use.

Maintainers will review reports and coordinate next steps. No specific response or remediation timeline is guaranteed.

## Non-security support

Use the regular issue forms for software bugs and GitHub Discussions (when enabled) for questions, troubleshooting, and general help.
