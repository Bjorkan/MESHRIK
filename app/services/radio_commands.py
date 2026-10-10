import logging
from collections.abc import Awaitable, Callable
from typing import Any

from meshcore import EventType

logger = logging.getLogger(__name__)


class RadioCommandServiceError(RuntimeError):
    """Base error for reusable radio command workflows."""


class PathHashModeUnsupportedError(RadioCommandServiceError):
    """Raised when firmware does not support path hash mode updates."""


class RepeatModeUnsupportedError(RadioCommandServiceError):
    """Raised when firmware does not support companion repeat mode updates."""


class RadioCommandRejectedError(RadioCommandServiceError):
    """Raised when the radio reports an error for a command."""


class KeystoreRefreshError(RadioCommandServiceError):
    """Raised when server-side keystore refresh fails after import."""


async def apply_radio_config_update(
    mc,
    update,
    *,
    path_hash_mode_supported: bool,
    set_path_hash_mode: Callable[[int], None],
    sync_radio_time_fn: Callable[[Any], Awaitable[Any]],
    repeat_enabled_supported: bool = False,
    current_repeat_enabled: bool | None = None,
    set_repeat_enabled: Callable[[bool], None] | None = None,
) -> None:
    """Apply a validated radio-config update to the connected radio."""
    if update.advert_location_source is not None:
        advert_loc_policy = 0 if update.advert_location_source == "off" else 1
        logger.info(
            "Setting advert location policy to %s",
            update.advert_location_source,
        )
        result = await mc.commands.set_advert_loc_policy(advert_loc_policy)
        if result is not None and result.type == EventType.ERROR:
            raise RadioCommandRejectedError(
                f"Failed to set advert location policy: {result.payload}"
            )

    if update.multi_acks_enabled is not None:
        multi_acks = 1 if update.multi_acks_enabled else 0
        logger.info("Setting multi ACKs to %d", multi_acks)
        result = await mc.commands.set_multi_acks(multi_acks)
        if result is not None and result.type == EventType.ERROR:
            raise RadioCommandRejectedError(f"Failed to set multi ACKs: {result.payload}")

    if update.telemetry_mode_base is not None:
        logger.info("Setting telemetry_mode_base to %d", update.telemetry_mode_base)
        result = await mc.commands.set_telemetry_mode_base(update.telemetry_mode_base)
        if result is not None and result.type == EventType.ERROR:
            raise RadioCommandRejectedError(
                f"Failed to set telemetry mode (base): {result.payload}"
            )

    if update.telemetry_mode_loc is not None:
        logger.info("Setting telemetry_mode_loc to %d", update.telemetry_mode_loc)
        result = await mc.commands.set_telemetry_mode_loc(update.telemetry_mode_loc)
        if result is not None and result.type == EventType.ERROR:
            raise RadioCommandRejectedError(
                f"Failed to set telemetry mode (location): {result.payload}"
            )

    if update.telemetry_mode_env is not None:
        logger.info("Setting telemetry_mode_env to %d", update.telemetry_mode_env)
        result = await mc.commands.set_telemetry_mode_env(update.telemetry_mode_env)
        if result is not None and result.type == EventType.ERROR:
            raise RadioCommandRejectedError(
                f"Failed to set telemetry mode (environment): {result.payload}"
            )

    if update.name is not None:
        logger.info("Setting radio name to %s", update.name)
        await mc.commands.set_name(update.name)

    if update.lat is not None or update.lon is not None:
        current_info = mc.self_info
        lat = update.lat if update.lat is not None else current_info.get("adv_lat", 0.0)
        lon = update.lon if update.lon is not None else current_info.get("adv_lon", 0.0)
        logger.info("Setting radio coordinates to %f, %f", lat, lon)
        await mc.commands.set_coords(lat=lat, lon=lon)

    if update.tx_power is not None:
        logger.info("Setting TX power to %d dBm", update.tx_power)
        await mc.commands.set_tx_power(val=update.tx_power)

    if update.repeat_enabled is not None and not repeat_enabled_supported:
        raise RepeatModeUnsupportedError("Firmware does not support companion repeat mode")

    if update.radio is not None or update.repeat_enabled is not None:
        radio = update.radio
        if radio is None:
            current_info = mc.self_info or {}
            radio_values = {
                "freq": current_info.get("radio_freq", 0.0),
                "bw": current_info.get("radio_bw", 0.0),
                "sf": current_info.get("radio_sf", 0),
                "cr": current_info.get("radio_cr", 0),
            }
        else:
            radio_values = {
                "freq": radio.freq,
                "bw": radio.bw,
                "sf": radio.sf,
                "cr": radio.cr,
            }
        repeat_enabled = (
            update.repeat_enabled if update.repeat_enabled is not None else current_repeat_enabled
        )
        logger.info(
            "Setting radio params: freq=%f MHz, bw=%f kHz, sf=%d, cr=%d, repeat=%s",
            radio_values["freq"],
            radio_values["bw"],
            radio_values["sf"],
            radio_values["cr"],
            repeat_enabled,
        )
        kwargs = dict(radio_values)
        if repeat_enabled is not None:
            kwargs["repeat"] = int(repeat_enabled)
        result = await mc.commands.set_radio(**kwargs)
        if result is not None and result.type == EventType.ERROR:
            raise RadioCommandRejectedError(f"Failed to set radio parameters: {result.payload}")
        if update.repeat_enabled is not None and set_repeat_enabled is not None:
            set_repeat_enabled(update.repeat_enabled)

    if update.path_hash_mode is not None:
        if not path_hash_mode_supported:
            raise PathHashModeUnsupportedError("Firmware does not support path hash mode setting")

        logger.info("Setting path hash mode to %d", update.path_hash_mode)
        result = await mc.commands.set_path_hash_mode(update.path_hash_mode)
        if result is not None and result.type == EventType.ERROR:
            raise RadioCommandRejectedError(f"Failed to set path hash mode: {result.payload}")
        set_path_hash_mode(update.path_hash_mode)

    await sync_radio_time_fn(mc)

    # Commands like set_name() write to flash but don't update cached self_info.
    # send_appstart() forces a fresh SELF_INFO so the response reflects changes.
    await mc.commands.send_appstart()


async def import_private_key_and_refresh_keystore(
    mc,
    key_bytes: bytes,
    *,
    export_and_store_private_key_fn: Callable[[Any], Awaitable[bool]],
) -> None:
    """Import a private key and refresh the in-memory keystore immediately."""
    result = await mc.commands.import_private_key(key_bytes)
    if result.type == EventType.ERROR:
        raise RadioCommandRejectedError(f"Failed to import private key: {result.payload}")

    keystore_refreshed = await export_and_store_private_key_fn(mc)
    if not keystore_refreshed:
        logger.warning("Keystore refresh failed after import, retrying once")
        keystore_refreshed = await export_and_store_private_key_fn(mc)

    if not keystore_refreshed:
        raise KeystoreRefreshError(
            "Private key imported on radio, but server-side keystore refresh failed. "
            "Reconnect to apply the new key for DM decryption."
        )


class RadioConfigRollbackError(RadioCommandServiceError):
    """The radio may have a partially applied configuration; inspect/reconnect."""


async def apply_radio_config_transaction(
    mc,
    update,
    *,
    path_hash_mode_supported: bool,
    current_path_hash_mode: int,
    set_path_hash_mode: Callable[[int], None],
    sync_radio_time_fn: Callable[[Any], Awaitable[Any]],
    repeat_enabled_supported: bool = False,
    current_repeat_enabled: bool | None = None,
    set_repeat_enabled: Callable[[bool], None] | None = None,
) -> None:
    """Best-effort compensating transaction for a multi-command config PATCH.

    MeshCore has no true transaction primitive. The entire apply/rollback stays
    under one worker command slot; no channel-send override may interleave.
    Validate feature support *before* modifying the radio, and restore only
    fields for which the radio supplied a previous effective value.
    """
    if update.path_hash_mode is not None and not path_hash_mode_supported:
        raise PathHashModeUnsupportedError("Firmware does not support path hash mode setting")
    if update.repeat_enabled is not None and not repeat_enabled_supported:
        raise RepeatModeUnsupportedError("Firmware does not support companion repeat mode")

    info = dict(mc.self_info or {})
    original: dict[str, Any] = {}
    names = {
        "name": "name",
        "lat": "adv_lat",
        "lon": "adv_lon",
        "tx_power": "tx_power",
        "telemetry_mode_base": "telemetry_mode_base",
        "telemetry_mode_loc": "telemetry_mode_loc",
        "telemetry_mode_env": "telemetry_mode_env",
    }
    for field, info_field in names.items():
        if getattr(update, field) is not None and info_field in info:
            original[field] = info[info_field]
    if update.advert_location_source is not None and "adv_loc_policy" in info:
        original["advert_location_source"] = "off" if info["adv_loc_policy"] == 0 else "current"
    if update.multi_acks_enabled is not None and "multi_acks" in info:
        original["multi_acks_enabled"] = bool(info["multi_acks"])
    if update.path_hash_mode is not None:
        original["path_hash_mode"] = current_path_hash_mode
    if update.repeat_enabled is not None and current_repeat_enabled is not None:
        original["repeat_enabled"] = current_repeat_enabled
    if update.radio is not None and all(
        key in info for key in ("radio_freq", "radio_bw", "radio_sf", "radio_cr")
    ):
        original["radio"] = update.radio.__class__(
            freq=info["radio_freq"],
            bw=info["radio_bw"],
            sf=info["radio_sf"],
            cr=info["radio_cr"],
        )

    options = {
        "path_hash_mode_supported": path_hash_mode_supported,
        "set_path_hash_mode": set_path_hash_mode,
        "sync_radio_time_fn": sync_radio_time_fn,
        "repeat_enabled_supported": repeat_enabled_supported,
        "current_repeat_enabled": current_repeat_enabled,
        "set_repeat_enabled": set_repeat_enabled,
    }
    try:
        await apply_radio_config_update(mc, update, **options)
    except BaseException as failure:
        # Firmware explicitly rejected the only requested command: nothing
        # else from this PATCH could have been applied. Retain existing 422
        # semantics instead of reporting a spurious failed rollback.
        if original and not (
            isinstance(failure, RadioCommandRejectedError) and len(update.model_fields_set) == 1
        ):
            try:
                # Shield one restoration attempt against HTTP cancellation.
                # The worker will quarantine if underlying transport ignores
                # cancellation rather than releasing the shared radio lock.
                import asyncio

                rollback = update.__class__(**original)
                restoration = asyncio.create_task(
                    apply_radio_config_update(mc, rollback, **options)
                )
                while not restoration.done():
                    try:
                        await asyncio.shield(restoration)
                    except asyncio.CancelledError:
                        # Cancellation of the HTTP request cannot free the
                        # radio command slot before compensation finishes.
                        continue
                await restoration
            except BaseException as exc:
                logger.error("Radio config rollback incomplete (%s)", type(exc).__name__)
                raise RadioConfigRollbackError(
                    "Could not restore previous radio settings; reconnect and inspect device"
                ) from None
        raise
