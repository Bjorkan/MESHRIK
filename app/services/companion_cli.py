"""Capability-gated, local *read-only* Companion CLI command adapter.

Only literal, audited commands are accepted. Never make this a generic CLI
proxy: firmware also accepts commands that expose credentials and erase data.
"""

from fastapi import HTTPException
from meshcore import EventType

from app.services.radio_runtime import radio_runtime

SAFE_LOCAL_COMMANDS = frozenset(
    {
        "get radio",
        "get cad",
        "get radio.rxgain",
        "get agc.reset.interval",
    }
)
MAX_REPLY_CHARS = 256


async def run_safe_local_cli(command: str, *, runtime=radio_runtime) -> str:
    if command not in SAFE_LOCAL_COMMANDS:
        raise HTTPException(status_code=403, detail="Local CLI command is not permitted")
    mc = runtime.require_connected()
    if (getattr(runtime, "firmware_ver_code", None) or 0) < 14:
        raise HTTPException(status_code=409, detail="Local CLI requires Companion protocol 14")
    if not callable(getattr(mc.commands, "run_cli_command", None)):
        raise HTTPException(
            status_code=501, detail="Installed meshcore SDK lacks local CLI support"
        )

    async def execute(connected):
        return await connected.commands.run_cli_command(command)

    # Keep the entire send + untagged CLI_REPLY waiter under the single worker.
    result = await runtime.run_radio_command("companion_local_cli", execute)
    if result is None or result.type != EventType.CLI_REPLY:
        raise HTTPException(status_code=502, detail="Companion CLI did not return a valid reply")
    response = result.payload.get("text", "")
    if not isinstance(response, str) or len(response) > MAX_REPLY_CHARS:
        raise HTTPException(status_code=502, detail="Companion CLI reply is invalid or too long")
    # Reject multiline/unprintable output rather than allowing arbitrary echoed
    # commands or unexpected privileged data to escape into a response.
    if "\n" in response or "\r" in response or any(ord(c) < 32 for c in response):
        raise HTTPException(status_code=502, detail="Companion CLI reply has invalid content")
    return response.removeprefix("> ")
