"""
Ephemeral keystore for storing sensitive keys in memory, plus the Ed25519
signing primitive used by fanout modules that need to sign requests with the
radio's own key.

The private key is stored in memory only and is never persisted to disk.
It's exported from the radio on startup and reconnect, then used for
server-side decryption of direct messages.
"""

import hashlib
import logging
from enum import StrEnum
from typing import TYPE_CHECKING

import nacl.bindings
from meshcore import EventType

from app.decoder import derive_public_key

if TYPE_CHECKING:
    from meshcore import MeshCore

logger = logging.getLogger(__name__)

NO_EVENT_RECEIVED_GUIDANCE = (
    "Radio command channel is unresponsive (no_event_received). Ensure that your firmware is not "
    "incompatible, outdated, or wrong-mode (e.g. repeater, not client), and that "
    "serial/TCP/BLE connectivity is successful (try another app and see if that one works?). The app cannot proceed because it cannot "
    "issue commands to the radio."
)

# Ed25519 group order (L) — used in the expanded signing primitive below
_L = 2**252 + 27742317777372353535851937790883648493

# In-memory storage for the private key and derived public key
_private_key: bytes | None = None
_public_key: bytes | None = None


class PrivateKeyExportStatus(StrEnum):
    NOT_ATTEMPTED = "not_attempted"
    AVAILABLE = "available"
    FIRMWARE_UNSUPPORTED = "firmware_unsupported"
    FAILED = "failed"


_private_key_export_status = PrivateKeyExportStatus.NOT_ATTEMPTED


def ed25519_sign_expanded(message: bytes, scalar: bytes, prefix: bytes, public_key: bytes) -> bytes:
    """Sign a message using MeshCore's expanded Ed25519 key format.

    MeshCore stores 64-byte keys as scalar(32) || prefix(32).  Standard
    Ed25519 libraries expect seed format and would re-SHA-512 the key, so we
    perform the signing manually using the already-expanded key material.

    Port of meshcore-packet-capture's ed25519_sign_with_expanded_key().
    """
    r = int.from_bytes(hashlib.sha512(prefix + message).digest(), "little") % _L
    R = nacl.bindings.crypto_scalarmult_ed25519_base_noclamp(r.to_bytes(32, "little"))
    k = int.from_bytes(hashlib.sha512(R + public_key + message).digest(), "little") % _L
    s = (r + k * int.from_bytes(scalar, "little")) % _L
    return R + s.to_bytes(32, "little")


def clear_keys() -> None:
    """Clear any stored private/public key material from memory."""
    global _private_key, _private_key_export_status, _public_key
    had_key = _private_key is not None or _public_key is not None
    _private_key = None
    _public_key = None
    _private_key_export_status = PrivateKeyExportStatus.NOT_ATTEMPTED
    if had_key:
        logger.info("Cleared in-memory keystore")


def set_private_key(key: bytes) -> None:
    """Store the private key in memory and derive the public key.

    Args:
        key: 64-byte Ed25519 private key in MeshCore format
    """
    global _private_key, _private_key_export_status, _public_key
    if len(key) != 64:
        raise ValueError(f"Private key must be 64 bytes, got {len(key)}")
    _private_key = key
    _public_key = derive_public_key(key)
    _private_key_export_status = PrivateKeyExportStatus.AVAILABLE
    logger.info("Private key stored in keystore (public key: %s...)", _public_key.hex()[:12])


def set_public_key_from_radio(key: str | bytes) -> None:
    """Track the connected radio's verified public identity without key export.

    A signing-only Companion still provides its 32-byte public identity in
    ``self_info``. Reconnect calls ``clear_keys`` before the next bootstrap.
    """
    global _public_key
    try:
        public_key = bytes.fromhex(key) if isinstance(key, str) else bytes(key)
    except ValueError as exc:
        raise ValueError("Invalid radio public identity") from exc
    if len(public_key) != 32:
        raise ValueError("Radio public identity must contain exactly 32 bytes")
    if _private_key is not None and derive_public_key(_private_key) != public_key:
        raise ValueError("Radio public identity does not match loaded private identity")
    _public_key = public_key


def get_private_key() -> bytes | None:
    """Get the stored private key.

    Returns:
        The 64-byte private key, or None if not set
    """
    return _private_key


def get_public_key() -> bytes | None:
    """Get the derived public key.

    Returns:
        The 32-byte public key derived from the private key, or None if not set
    """
    return _public_key


def has_private_key() -> bool:
    """Check if a private key is stored.

    Returns:
        True if a private key is available
    """
    return _private_key is not None


def get_private_key_export_status() -> PrivateKeyExportStatus:
    """Return capability-safe export state without exposing key material."""
    return _private_key_export_status


async def export_and_store_private_key(mc: "MeshCore") -> bool:
    """Export private key from the radio and store it in the keystore.

    This should be called on startup and after each reconnect.

    Args:
        mc: Connected MeshCore instance

    Returns:
        True if the private key was successfully exported and stored
    """
    global _private_key_export_status

    logger.info("Exporting private key from radio...")
    try:
        result = await mc.commands.export_private_key()

        if result.type == EventType.PRIVATE_KEY:
            private_key_bytes = result.payload["private_key"]
            set_private_key(private_key_bytes)
            return True
        elif result.type == EventType.DISABLED:
            _private_key_export_status = PrivateKeyExportStatus.FIRMWARE_UNSUPPORTED
            logger.warning(
                "Private key export disabled on radio firmware. "
                "Server-side DM decryption will not be available. "
                "Enable ENABLE_PRIVATE_KEY_EXPORT=1 in firmware to enable this feature."
            )
            return False
        else:
            reason = result.payload.get("reason") if isinstance(result.payload, dict) else None
            if result.type == EventType.ERROR and reason == "no_event_received":
                _private_key_export_status = PrivateKeyExportStatus.FAILED
                logger.error("%s Raw response: %s", NO_EVENT_RECEIVED_GUIDANCE, result.payload)
                raise RuntimeError(NO_EVENT_RECEIVED_GUIDANCE)
            logger.error("Failed to export private key: %s", result.payload)
            _private_key_export_status = PrivateKeyExportStatus.FAILED
            return False
    except RuntimeError:
        raise
    except Exception as e:
        _private_key_export_status = PrivateKeyExportStatus.FAILED
        logger.error("Error exporting private key: %s", e)
        return False
