"""Generation-fenced radio initialization through the single command worker.

Transport creation/teardown remains owned by ``RadioManager``. Every command
after a transport connects is admitted as a bounded lifecycle stage through the
same worker as user and periodic commands. The readiness barrier admits only
lifecycle jobs until the selected policy has settled.
"""

import asyncio
import logging
import os
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime
from typing import Any

from app.config import StartupPolicy, settings
from app.services.radio_jobs import (
    TERMINAL_STATES,
    RadioJobKind,
    RadioJobResult,
    RadioJobState,
    RadioStartupStage,
)

logger = logging.getLogger(__name__)

# Each stage owns an independent deadline. There is intentionally no opaque
# five-minute setup critical section or automatic retry loop.
READ_ONLY_STAGE_TIMEOUT_SECONDS = 30.0
MAINTENANCE_STAGE_TIMEOUT_SECONDS = 60.0


class LifecycleStageError(RuntimeError):
    def __init__(self, stage: RadioStartupStage, result: RadioJobResult | None = None):
        super().__init__(f"Radio lifecycle stage {stage.value} did not complete")
        self.stage = stage
        self.result = result


class StaleLifecycleError(RuntimeError):
    pass


def _clean_device_string(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    cleaned = value.strip()
    return cleaned or None


def _decode_fixed_string(raw: bytes, start: int, length: int) -> str | None:
    if len(raw) < start:
        return None
    return _clean_device_string(
        raw[start : start + length].decode("utf-8", "ignore").replace("\0", "")
    )


def _generation(radio_manager: Any) -> int:
    return int(getattr(radio_manager, "radio_generation", 0))


def _assert_generation(radio_manager: Any, expected: int) -> None:
    if _generation(radio_manager) != expected or not radio_manager.is_connected:
        raise StaleLifecycleError("Radio transport changed during initialization")


async def _query_device_info(radio_manager: Any, mc: Any) -> None:
    """Read and cache non-sensitive device capabilities for this generation."""
    reader = mc._reader
    original_handle_rx = reader.handle_rx
    captured_frame: list[bytes] = []

    async def capture_handle_rx(data: bytearray) -> None:
        from meshcore.packets import PacketType

        if len(data) > 0 and data[0] == PacketType.DEVICE_INFO.value:
            captured_frame.append(bytes(data))
        await original_handle_rx(data)

    reader.handle_rx = capture_handle_rx
    radio_manager.device_info_loaded = False
    radio_manager.max_contacts = None
    radio_manager.device_model = None
    radio_manager.firmware_build = None
    radio_manager.firmware_version = None
    radio_manager.firmware_ver_code = None
    radio_manager.max_channels = 40
    radio_manager.repeat_enabled = None
    radio_manager.repeat_enabled_supported = False
    radio_manager.path_hash_mode = 0
    radio_manager.path_hash_mode_supported = False
    try:
        device_query = await mc.commands.send_device_query()
        payload = (
            device_query.payload
            if device_query is not None and isinstance(device_query.payload, dict)
            else {}
        )
        payload_max_contacts = payload.get("max_contacts")
        if isinstance(payload_max_contacts, int):
            radio_manager.max_contacts = max(1, payload_max_contacts)
        payload_max_channels = payload.get("max_channels")
        if isinstance(payload_max_channels, int):
            radio_manager.max_channels = max(1, payload_max_channels)
        radio_manager.device_model = _clean_device_string(payload.get("model"))
        radio_manager.firmware_build = _clean_device_string(payload.get("fw_build"))
        radio_manager.firmware_version = _clean_device_string(payload.get("ver"))

        fw_ver = payload.get("fw ver")
        if isinstance(fw_ver, int) and fw_ver >= 3:
            radio_manager.device_info_loaded = True
            radio_manager.firmware_ver_code = fw_ver
        if isinstance(fw_ver, int) and fw_ver >= 9:
            radio_manager.repeat_enabled_supported = True
            payload_repeat = payload.get("repeat")
            if isinstance(payload_repeat, bool):
                radio_manager.repeat_enabled = payload_repeat
        if isinstance(payload.get("path_hash_mode"), int):
            radio_manager.path_hash_mode = payload["path_hash_mode"]
            radio_manager.path_hash_mode_supported = True

        if captured_frame:
            raw = captured_frame[-1]
            fw_ver = raw[1] if len(raw) > 1 else 0
            if fw_ver >= 3:
                radio_manager.device_info_loaded = True
                radio_manager.firmware_ver_code = fw_ver
                if radio_manager.max_contacts is None and len(raw) >= 3:
                    radio_manager.max_contacts = max(1, raw[2] * 2)
                if len(raw) >= 4 and not isinstance(payload_max_channels, int):
                    radio_manager.max_channels = max(1, raw[3])
                if radio_manager.firmware_build is None:
                    radio_manager.firmware_build = _decode_fixed_string(raw, 8, 12)
                if radio_manager.device_model is None:
                    radio_manager.device_model = _decode_fixed_string(raw, 20, 40)
                if radio_manager.firmware_version is None:
                    radio_manager.firmware_version = _decode_fixed_string(raw, 60, 20)
            if fw_ver >= 9:
                radio_manager.repeat_enabled_supported = True
                if radio_manager.repeat_enabled is None and len(raw) >= 81:
                    radio_manager.repeat_enabled = raw[80] != 0
            if not radio_manager.path_hash_mode_supported and fw_ver >= 10 and len(raw) >= 82:
                radio_manager.path_hash_mode = raw[81]
                radio_manager.path_hash_mode_supported = True

        if radio_manager.device_info_loaded:
            logger.info(
                "Radio device info: model=%s build=%s version=%s max_contacts=%s max_channels=%d",
                radio_manager.device_model or "unknown",
                radio_manager.firmware_build or "unknown",
                radio_manager.firmware_version or "unknown",
                radio_manager.max_contacts if radio_manager.max_contacts is not None else "unknown",
                radio_manager.max_channels,
            )
            # Read-only clock visibility is allowed in every policy.
            try:
                time_result = await mc.commands.get_time()
                radio_time = (
                    time_result.payload.get("time")
                    if time_result is not None and time_result.payload
                    else None
                )
                if isinstance(radio_time, int):
                    logger.info(
                        "Radio clock at connect: epoch=%d utc=%s",
                        radio_time,
                        datetime.fromtimestamp(radio_time, UTC).strftime("%Y-%m-%d %H:%M:%S UTC"),
                    )
            except Exception:
                logger.debug("Failed to query radio clock after device info")
    finally:
        reader.handle_rx = original_handle_rx


async def _direct_test_stage(
    radio_manager: Any,
    action: Callable[[Any], Awaitable[None]],
    *,
    generation: int,
) -> None:
    """Compatibility seam for isolated unit tests without a started lifespan."""
    await radio_manager._acquire_operation_lock("lifecycle_test_stage", blocking=True)
    try:
        _assert_generation(radio_manager, generation)
        mc = radio_manager.meshcore
        if mc is None:
            raise StaleLifecycleError("Radio disconnected during initialization")
        await action(mc)
        _assert_generation(radio_manager, generation)
    finally:
        radio_manager._release_operation_lock("lifecycle_test_stage")


async def _run_stage(
    radio_manager: Any,
    *,
    generation: int,
    stage: RadioStartupStage,
    kind: RadioJobKind,
    action: Callable[[Any], Awaitable[None]],
    timeout_seconds: float,
) -> None:
    """Execute one bounded stage and release the command permit afterwards."""
    _assert_generation(radio_manager, generation)
    radio_manager.startup_stage = stage.value

    from app.services.radio_job_worker import RadioCommandOutcome, radio_job_worker

    async def command(mc: Any) -> RadioCommandOutcome:
        _assert_generation(radio_manager, generation)
        await action(mc)
        _assert_generation(radio_manager, generation)
        return RadioCommandOutcome.FINISHED

    worker_owns_manager = False
    if radio_job_worker.running:
        try:
            worker_owns_manager = radio_job_worker.runtime.manager is radio_manager
        except Exception:
            worker_owns_manager = False

    if not worker_owns_manager:
        # Production must NEVER bypass the worker. Isolated manager tests may
        # use this fake transport seam without starting the FastAPI lifespan.
        if "PYTEST_CURRENT_TEST" not in os.environ:
            from app.services.radio_job_scheduler import RadioQueueUnavailableError

            raise RadioQueueUnavailableError("Radio lifecycle requires the single worker")
        await asyncio.wait_for(
            _direct_test_stage(radio_manager, action, generation=generation),
            timeout=timeout_seconds,
        )
        return

    job = radio_job_worker.submit_lifecycle(
        kind,
        command,
        scope=f"lifecycle-generation-{generation}",
        coalesce_key=f"{generation}:{stage.value}",
        queue_timeout_seconds=timeout_seconds,
        command_timeout_seconds=timeout_seconds,
        response_timeout_seconds=timeout_seconds,
    )
    try:
        while True:
            current = radio_job_worker.scheduler.get(job.id)
            if current is None:
                raise LifecycleStageError(stage, RadioJobResult.REJECTED)
            if current.state in TERMINAL_STATES:
                if current.state == RadioJobState.COMPLETED:
                    return
                raise LifecycleStageError(stage, current.result)
            _assert_generation(radio_manager, generation)
            await radio_job_worker.scheduler.wait_for_change(0.25)
    except (asyncio.CancelledError, StaleLifecycleError):
        # A queued stage must not run after its owning workflow is cancelled.
        # An executing command cannot be retracted; allow the bounded worker
        # stage to finish/timeout before a disconnect may acquire the lock.
        current = radio_job_worker.scheduler.get(job.id)
        if current is not None and current.state not in TERMINAL_STATES:
            radio_job_worker.cancel(job.id)
            try:
                async with asyncio.timeout(timeout_seconds + 2):
                    while True:
                        current = radio_job_worker.scheduler.get(job.id)
                        if current is None or current.state in TERMINAL_STATES:
                            break
                        await radio_job_worker.scheduler.wait_for_change(0.1)
            except TimeoutError:
                logger.error("Lifecycle command did not settle during cancellation")
                # The worker itself quarantines an unresponsive transport.
        raise


def _set_skipped_stages(radio_manager: Any, policy: StartupPolicy) -> None:
    optional = {
        "key_export": settings.startup_export_private_key,
        "clock_sync": settings.startup_sync_clock,
        "flood_scope": settings.startup_apply_flood_scope,
        "advertisement": settings.startup_send_advertisement,
        "message_drain": settings.startup_drain_messages,
        "contact_reconcile": settings.startup_reconcile_contacts,
        "channel_clear": settings.startup_clear_channel_slots,
        "telemetry_collection": settings.startup_enable_telemetry_collection,
        "periodic_offload": settings.startup_allow_periodic_offload,
    }
    if policy != StartupPolicy.FULL:
        radio_manager.startup_skipped_stages = list(optional)
    else:
        radio_manager.startup_skipped_stages = [
            name for name, enabled in optional.items() if not enabled
        ]


async def _run_lifecycle_workflow(radio_manager: Any, generation: int) -> None:
    from app.event_handlers import register_event_handlers
    from app.keystore import export_and_store_private_key
    from app.radio_sync import (
        drain_pending_messages,
        send_advertisement,
        start_background_contact_reconciliation,
        start_message_polling,
        start_periodic_advert,
        start_periodic_sync,
        start_telemetry_collect,
        sync_and_offload_channels,
        sync_channels_from_radio,
        sync_contacts_from_radio,
        sync_radio_time,
    )

    policy = settings.effective_startup_policy
    radio_manager._setup_in_progress = True
    radio_manager._setup_complete = False
    radio_manager.readiness_state = "initializing"
    radio_manager.startup_policy = policy.value
    radio_manager.startup_error_stage = None
    radio_manager.startup_stage = RadioStartupStage.TRANSPORT.value
    _set_skipped_stages(radio_manager, policy)
    degraded = False
    contact_snapshot: dict[str, Any] = {}

    if settings.passive_startup or settings.skip_post_connect_sync:
        logger.warning(
            "Deprecated startup safety flag mapped to startup policy 'passive'; "
            "use MESHCORE_STARTUP_POLICY=passive instead"
        )
    logger.info("Radio lifecycle generation %d using %s policy", generation, policy.value)

    try:
        _assert_generation(radio_manager, generation)
        mc = radio_manager.meshcore
        if mc is None:
            raise StaleLifecycleError("Radio disconnected before initialization")
        stages: list[
            tuple[
                RadioStartupStage,
                RadioJobKind,
                Callable[[Any], Awaitable[None]],
                float,
                bool,
            ]
        ] = []

        async def device_bootstrap(current: Any) -> None:
            register_event_handlers(current)
            await _query_device_info(radio_manager, current)

        stages.append(
            (
                RadioStartupStage.DEVICE_INFO,
                RadioJobKind.LIFECYCLE_DEVICE_INFO,
                device_bootstrap,
                READ_ONLY_STAGE_TIMEOUT_SECONDS,
                True,  # Capability discovery must succeed before user command admission.
            )
        )

        if policy in {StartupPolicy.SYNC, StartupPolicy.FULL}:

            async def contact_sync(current: Any) -> None:
                nonlocal contact_snapshot
                contact_snapshot = await sync_contacts_from_radio(current)
                if "error" in contact_snapshot:
                    raise RuntimeError("Contact snapshot failed")

            stages.append(
                (
                    RadioStartupStage.CONTACT_SYNC,
                    RadioJobKind.LIFECYCLE_CONTACT_SYNC,
                    contact_sync,
                    MAINTENANCE_STAGE_TIMEOUT_SECONDS,
                    False,
                )
            )

            async def channel_sync(current: Any) -> None:
                result = await sync_channels_from_radio(current)
                if "error" in result:
                    raise RuntimeError("Channel snapshot failed")

            if policy == StartupPolicy.FULL and settings.startup_clear_channel_slots:

                async def channel_clear(current: Any) -> None:
                    result = await sync_and_offload_channels(current)
                    if "error" in result:
                        raise RuntimeError("Channel offload failed")

                stages.append(
                    (
                        RadioStartupStage.CHANNEL_CLEAR,
                        RadioJobKind.LIFECYCLE_CHANNEL_CLEAR,
                        channel_clear,
                        MAINTENANCE_STAGE_TIMEOUT_SECONDS,
                        False,
                    )
                )
            else:
                stages.append(
                    (
                        RadioStartupStage.CHANNEL_SYNC,
                        RadioJobKind.LIFECYCLE_CHANNEL_SYNC,
                        channel_sync,
                        MAINTENANCE_STAGE_TIMEOUT_SECONDS,
                        False,
                    )
                )

        if policy == StartupPolicy.FULL:
            if settings.startup_export_private_key:

                async def export_key(current: Any) -> None:
                    await export_and_store_private_key(current)

                stages.append(
                    (
                        RadioStartupStage.KEY_EXPORT,
                        RadioJobKind.LIFECYCLE_KEY_EXPORT,
                        export_key,
                        READ_ONLY_STAGE_TIMEOUT_SECONDS,
                        False,
                    )
                )
            if settings.startup_sync_clock:

                async def clock_sync(current: Any) -> None:
                    if not await sync_radio_time(current):
                        raise RuntimeError("Clock sync rejected")

                stages.append(
                    (
                        RadioStartupStage.CLOCK_SYNC,
                        RadioJobKind.LIFECYCLE_CLOCK_SYNC,
                        clock_sync,
                        READ_ONLY_STAGE_TIMEOUT_SECONDS,
                        False,
                    )
                )
            if settings.startup_apply_flood_scope:
                from app.region_scope import normalize_region_scope
                from app.repository import AppSettingsRepository
                from app.services.flood_scope import set_radio_flood_scope

                app_settings = await AppSettingsRepository.get()
                scope = normalize_region_scope(app_settings.flood_scope)

                async def apply_scope(current: Any) -> None:
                    await set_radio_flood_scope(
                        current,
                        scope,
                        fw_ver=radio_manager.firmware_ver_code,
                    )

                stages.append(
                    (
                        RadioStartupStage.FLOOD_SCOPE,
                        RadioJobKind.LIFECYCLE_FLOOD_SCOPE,
                        apply_scope,
                        READ_ONLY_STAGE_TIMEOUT_SECONDS,
                        False,
                    )
                )
            if settings.startup_send_advertisement:

                async def advertise(current: Any) -> None:
                    await send_advertisement(current)

                stages.append(
                    (
                        RadioStartupStage.ADVERTISEMENT,
                        RadioJobKind.LIFECYCLE_ADVERTISEMENT,
                        advertise,
                        READ_ONLY_STAGE_TIMEOUT_SECONDS,
                        False,
                    )
                )
            if settings.startup_drain_messages:

                async def drain(current: Any) -> None:
                    await drain_pending_messages(current)

                stages.append(
                    (
                        RadioStartupStage.MESSAGE_DRAIN,
                        RadioJobKind.LIFECYCLE_MESSAGE_DRAIN,
                        drain,
                        MAINTENANCE_STAGE_TIMEOUT_SECONDS,
                        False,
                    )
                )

        async def start_auto_fetch(current: Any) -> None:
            await current.start_auto_message_fetching()

        stages.append(
            (
                RadioStartupStage.AUTO_FETCH,
                RadioJobKind.LIFECYCLE_AUTO_FETCH,
                start_auto_fetch,
                READ_ONLY_STAGE_TIMEOUT_SECONDS,
                True,
            )
        )

        for stage, kind, action, timeout, critical in stages:
            try:
                await _run_stage(
                    radio_manager,
                    generation=generation,
                    stage=stage,
                    kind=kind,
                    action=action,
                    timeout_seconds=timeout,
                )
            except StaleLifecycleError:
                raise
            except Exception:
                radio_manager.startup_error_stage = stage.value
                from app.services.radio_job_worker import radio_job_worker

                if critical or radio_job_worker.quarantined:
                    radio_manager.readiness_state = "failed"
                    radio_manager.startup_stage = RadioStartupStage.RECOVERY_REQUIRED.value
                    raise
                degraded = True
                logger.warning("Radio lifecycle stage %s failed", stage.value, exc_info=True)

        _assert_generation(radio_manager, generation)
        radio_manager._setup_complete = True
        radio_manager._setup_generation = generation
        radio_manager.readiness_state = "degraded" if degraded else "ready"
        radio_manager.startup_stage = (
            RadioStartupStage.RECOVERY_REQUIRED.value
            if degraded
            else RadioStartupStage.COMPLETE.value
        )

        # These loops use the normal scheduler path and are only enabled by
        # explicit full-policy permissions.
        if policy == StartupPolicy.FULL:
            if settings.startup_reconcile_contacts and contact_snapshot:
                start_background_contact_reconciliation(
                    initial_radio_contacts=contact_snapshot.get("radio_contacts", {}),
                    expected_mc=radio_manager.meshcore,
                    autoevict=False,
                )
            if settings.startup_sync_clock or settings.startup_allow_periodic_offload:
                start_periodic_sync()
            if settings.startup_send_advertisement:
                start_periodic_advert()
            if settings.startup_drain_messages:
                start_message_polling()
            if settings.startup_enable_telemetry_collection:
                start_telemetry_collect()

        logger.info(
            "Radio lifecycle generation %d settled as %s",
            generation,
            radio_manager.readiness_state,
        )
    except StaleLifecycleError:
        logger.info("Radio lifecycle generation %d was superseded", generation)
        raise
    except Exception:
        if _generation(radio_manager) == generation:
            radio_manager.readiness_state = "failed"
            radio_manager.startup_stage = RadioStartupStage.RECOVERY_REQUIRED.value
            radio_manager._setup_complete = False
        raise
    finally:
        if _generation(radio_manager) == generation:
            radio_manager._setup_in_progress = False


async def run_post_connect_setup(radio_manager: Any, *, force: bool = False) -> None:
    """Coalesce one lifecycle workflow per transport generation."""
    if not radio_manager.meshcore or not radio_manager.is_connected:
        return
    generation = _generation(radio_manager)
    active = getattr(radio_manager, "_setup_task", None)
    active_generation = getattr(radio_manager, "_setup_task_generation", None)
    if active is not None and not active.done() and active_generation == generation:
        await asyncio.shield(active)
        return
    if (
        not force
        and radio_manager.is_setup_complete
        and getattr(radio_manager, "_setup_generation", None) == generation
    ):
        return

    task = asyncio.create_task(
        _run_lifecycle_workflow(radio_manager, generation),
        name=f"radio-lifecycle-{generation}",
    )
    radio_manager._setup_task = task
    radio_manager._setup_task_generation = generation
    try:
        await asyncio.shield(task)
    finally:
        if getattr(radio_manager, "_setup_task", None) is task and task.done():
            radio_manager._setup_task = None


async def cancel_radio_lifecycle(radio_manager: Any) -> None:
    task = getattr(radio_manager, "_setup_task", None)
    if task is None or task.done():
        return
    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass


async def prepare_connected_radio(
    radio_manager: Any,
    *,
    broadcast_on_success: bool = True,
    force: bool = False,
) -> bool:
    """Run or retry the current generation's bounded lifecycle workflow."""
    from app.websocket import broadcast_health

    if not radio_manager.connection_desired:
        if radio_manager.is_connected:
            await radio_manager.disconnect()
        return False

    try:
        if force:
            await radio_manager.post_connect_setup(force=True)
        else:
            await radio_manager.post_connect_setup()
    except Exception:
        radio_manager.readiness_state = "failed"
        radio_manager.startup_stage = RadioStartupStage.RECOVERY_REQUIRED.value
        radio_manager._setup_complete = False
        raise
    if not radio_manager.connection_desired:
        return False
    readiness = getattr(radio_manager, "readiness_state", None)
    settled = readiness in {"ready", "degraded"} if isinstance(readiness, str) else True
    if not settled:
        return False
    radio_manager._last_connected = True
    if broadcast_on_success:
        broadcast_health(True, radio_manager.connection_info)
    return True


async def reconnect_and_prepare_radio(
    radio_manager: Any,
    *,
    broadcast_on_success: bool = True,
) -> bool:
    """Connect the transport, then initialize that generation through the worker."""
    connected = await radio_manager.reconnect(broadcast_on_success=False)
    if not connected:
        return False
    return await prepare_connected_radio(
        radio_manager,
        broadcast_on_success=broadcast_on_success,
    )


async def connection_monitor_loop(radio_manager: Any) -> None:
    """Reconnect transports without automatically replaying failed setup stages."""
    from app.websocket import broadcast_health

    while True:
        try:
            await asyncio.sleep(5)
            connected = radio_manager.is_connected
            if radio_manager._last_connected and not connected:
                broadcast_health(False, radio_manager.connection_info)
                radio_manager._last_connected = False

            if not radio_manager.connection_desired:
                if connected:
                    await radio_manager.disconnect()
                continue

            if not connected and not radio_manager.is_reconnecting:
                await reconnect_and_prepare_radio(radio_manager, broadcast_on_success=True)
            elif (
                connected
                and not radio_manager.is_setup_in_progress
                and getattr(radio_manager, "readiness_state", "connecting") == "connecting"
            ):
                await prepare_connected_radio(radio_manager, broadcast_on_success=True)
        except asyncio.CancelledError:
            break
        except Exception:
            # A setup failure is terminal for this generation. Manual retry or
            # a genuine reconnect creates the next bounded attempt.
            logger.exception("Radio lifecycle failed; manual recovery is required")
