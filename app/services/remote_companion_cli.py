"""Explicit, restricted Companion-to-Companion remote CLI over RF.

Remote authority is decided by the other device. Local admission never proves
that the command executed or that its response was delivered.
"""

from fastapi import HTTPException
from meshcore import EventType
from meshcore.packets import AdvType

from app.repository import ContactRepository
from app.services.radio_runtime import radio_runtime

ALLOWED_REMOTE_READS = frozenset({"get radio", "get cad", "get dutycycle"})


async def remote_read_command(
    *, public_key: str, command: str, consent: bool, runtime=radio_runtime
) -> dict[str, str]:
    if command not in ALLOWED_REMOTE_READS or not consent:
        raise HTTPException(status_code=403, detail="Remote CLI needs explicit read-only consent")
    if len(public_key) != 64 or any(c not in "0123456789abcdefABCDEF" for c in public_key):
        raise HTTPException(status_code=422, detail="Invalid Companion identity")
    runtime.require_connected()
    if (getattr(runtime, "firmware_ver_code", None) or 0) < 14:
        raise HTTPException(status_code=409, detail="Remote Companion CLI requires protocol 14")
    contact = await ContactRepository.get_by_key(public_key)
    if contact is None or contact.type != AdvType.CHAT.value or not contact.on_radio:
        raise HTTPException(status_code=409, detail="Companion contact not verified on the radio")

    async def execute(mc):
        return await mc.commands.send_cmd(public_key, command, dst_type=AdvType.CHAT.value)

    result = await runtime.run_radio_command("remote_companion_cli", execute)
    if result is None or result.type != EventType.MSG_SENT:
        raise HTTPException(status_code=502, detail="Remote CLI RF command was not accepted")
    # No reliable request ID in CLI_DATA replies. Do not attribute a late or
    # concurrent response by prefix alone and falsely declare execution.
    return {"status": "radio_accepted_remote_execution_unconfirmed"}
