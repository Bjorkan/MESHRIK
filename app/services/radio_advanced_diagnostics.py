"""Safe protocol-14 radio diagnostics via a single read-only worker job."""

import re
from datetime import UTC, datetime

from fastapi import HTTPException
from meshcore import EventType

from app.services.radio_runtime import radio_runtime

_READS = {
    "cad": "get cad",
    "rx_gain": "get radio.rxgain",
    "agc_reset_interval": "get agc.reset.interval",
}


def parse_diagnostic(name: str, result: str) -> bool | int | None:
    value = result.strip().removeprefix("> ").lower()
    if name in {"cad", "rx_gain"}:
        return {"on": True, "off": False}.get(value)
    if name == "agc_reset_interval" and re.fullmatch(r"\d{1,9}", value):
        return int(value)
    return None


async def read_advanced_radio_diagnostics(*, runtime=radio_runtime) -> dict:
    mc = runtime.require_connected()
    if (getattr(runtime, "firmware_ver_code", None) or 0) < 14:
        raise HTTPException(status_code=409, detail="Advanced diagnostics require Companion 1.18")
    if not callable(getattr(mc.commands, "run_cli_command", None)):
        raise HTTPException(status_code=501, detail="SDK lacks protocol-14 local CLI")

    async def read_all(connected):
        measurements = {}
        for key, command in _READS.items():
            result = await connected.commands.run_cli_command(command)
            if result is None or result.type != EventType.CLI_REPLY:
                measurements[key] = None
                continue
            response = result.payload.get("text")
            measurements[key] = (
                parse_diagnostic(key, response) if isinstance(response, str) else None
            )
        return measurements

    measurements = await runtime.run_radio_command("radio_advanced_diagnostics", read_all)
    return {
        "observed_at": datetime.now(UTC).isoformat(),
        "source": "companion_cli_v14",
        "values": measurements,
    }
