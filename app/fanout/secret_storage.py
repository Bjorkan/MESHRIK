"""Encryption for Community MQTT topic credentials at rest.

Key is node-local: back it up securely or set MESHCORE_FANOUT_ENCRYPTION_KEY
(base64url of 32 random bytes) before initial token creation. File key is mode
0600, in the private database directory, and is never returned in REST.
"""

from __future__ import annotations

import base64
import os
from pathlib import Path

from nacl import secret, utils

from app.config import settings

_PREFIX = "secretbox:v1:"


def _key() -> bytes:
    value = os.environ.get("MESHCORE_FANOUT_ENCRYPTION_KEY", "").strip()
    if value:
        result = base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))
        if len(result) != secret.SecretBox.KEY_SIZE:
            raise ValueError("MESHCORE_FANOUT_ENCRYPTION_KEY must be 32 bytes")
        return result
    path = Path(settings.database_path).parent / ".fanout-secret.key"
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    except FileExistsError:
        pass
    else:
        with os.fdopen(fd, "wb") as file:
            file.write(utils.random(secret.SecretBox.KEY_SIZE))
    if os.name != "nt" and (path.stat().st_mode & 0o077):
        raise PermissionError("Fanout encryption key file must not be group/world readable")
    return path.read_bytes()


def encrypt_token(token: str) -> str:
    if not token or token.startswith(_PREFIX):
        return token
    payload = secret.SecretBox(_key()).encrypt(token.encode("utf-8"))
    return _PREFIX + base64.urlsafe_b64encode(bytes(payload)).decode("ascii")


def decrypt_token(value: str) -> str:
    if not value.startswith(_PREFIX):
        return value  # Legacy plaintext: encrypt on next save without loss.
    ciphertext = base64.urlsafe_b64decode(value[len(_PREFIX) :])
    return secret.SecretBox(_key()).decrypt(ciphertext).decode("utf-8")
