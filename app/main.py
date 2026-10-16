import logging
import sys

# ---------------------------------------------------------------------------
# Windows event-loop advisory for MQTT fanout
# ---------------------------------------------------------------------------
# On Windows, uvicorn's default event loop (ProactorEventLoop) does not
# implement add_reader()/add_writer(), which paho-mqtt (via aiomqtt) requires.
# We cannot fix this from inside the app — the loop is already created by the
# time this module is imported.  Log a prominent warning so Windows operators
# who want MQTT know to add ``--loop none`` to their uvicorn command.
# ---------------------------------------------------------------------------
if sys.platform == "win32":
    import asyncio as _asyncio

    _loop = _asyncio.get_event_loop()
    _is_proactor = type(_loop).__name__ == "ProactorEventLoop"
    if _is_proactor:
        print(
            "\n" + "!" * 78 + "\n"
            "  NOTE FOR WINDOWS USERS\n" + "!" * 78 + "\n"
            "\n"
            "  The running event loop is ProactorEventLoop, which is not\n"
            "  compatible with MQTT fanout (aiomqtt / paho-mqtt).\n"
            "\n"
            "  If you use MQTT integrations, restart with --loop none:\n"
            "\n"
            "    uv run uvicorn app.main:app \033[1m--loop none\033[0m"
            " [... other options ...]\n"
            "\n"
            "  Everything else works fine as-is.\n"
            "\n" + "!" * 78 + "\n",
            file=sys.stderr,
            flush=True,
        )
    del _loop, _is_proactor

import asyncio
import re
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import JSONResponse
from starlette.types import Scope

from app.api_docs import API_DESCRIPTION, API_TAGS_METADATA, register_api_docs_routes
from app.config import settings as server_settings
from app.config import setup_logging
from app.database import db
from app.frontend_static import (
    register_first_available_frontend_static_routes,
    register_frontend_missing_fallback,
)
from app.radio import RadioDisconnectedError, RadioOperationBusyError
from app.radio_sync import (
    stop_background_contact_reconciliation,
    stop_message_polling,
    stop_periodic_advert,
    stop_periodic_sync,
    stop_telemetry_collect,
)
from app.routers import (
    channels,
    contacts,
    debug,
    fanout,
    health,
    messages,
    packets,
    push,
    radio,
    radio_jobs,
    read_state,
    repeaters,
    rooms,
    settings,
    statistics,
    ws,
)
from app.security import add_optional_basic_auth_middleware
from app.services.radio_job_worker import RadioProcessLease, radio_job_scheduler, radio_job_worker
from app.services.radio_runtime import radio_runtime as radio_manager
from app.services.radio_stats import start_radio_stats_sampling, stop_radio_stats_sampling
from app.version_info import get_app_build_info

setup_logging()
logger = logging.getLogger(__name__)


async def _startup_radio_connect_and_setup() -> None:
    """Connect/setup the radio in the background so HTTP serving can start immediately."""
    try:
        connected = await radio_manager.reconnect_and_prepare(broadcast_on_success=True)
        if connected:
            logger.info("Connected to radio")
        else:
            logger.warning("Failed to connect to radio on startup")
    except Exception:
        logger.exception("Failed to connect to radio on startup")


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Manage one process-owned transport, worker and database lifecycle."""
    # This lock protects *all* legacy radio flows, not just new scheduler jobs.
    # If uvicorn --workers > 1, only one process can enter the lifespan.
    radio_owner = RadioProcessLease()
    radio_owner.acquire()
    database_open = False
    startup_radio_task = None
    unsubscribe_job = None
    unsubscribe_activity = None
    try:
        await db.connect()
        database_open = True
        logger.info("Database connected")
        # A crash can occur after the Companion accepted a send but before the
        # status write. Never retry or present such an intent as unsent/confirmed.
        from app.repository.messages import MessageRepository

        interrupted = await MessageRepository.recover_interrupted_outgoing_sends()
        if interrupted:
            logger.warning("Marked %d interrupted outgoing sends as unknown", interrupted)
        radio_job_worker.start()
        from app.websocket import broadcast_event

        unsubscribe_job = radio_job_scheduler.subscribe(
            lambda job: broadcast_event("radio_job", job.model_dump(mode="json"))
        )
        unsubscribe_activity = radio_job_scheduler.subscribe_activity(
            lambda event: broadcast_event("radio_activity", event.model_dump(mode="json"))
        )

        # Initialize VAPID keys for Web Push (generates on first run).
        from app.push.vapid import ensure_vapid_keys

        try:
            await ensure_vapid_keys()
        except Exception:
            logger.warning("Failed to initialize VAPID keys for Web Push", exc_info=True)

        # Seed default channels before radio initial setup has finished.
        from app.radio_sync import ensure_default_channels

        await ensure_default_channels()
        await start_radio_stats_sampling()
        await radio_manager.start_connection_monitor()

        from app.fanout.manager import fanout_manager

        try:
            await fanout_manager.load_from_db()
        except Exception:
            logger.exception("Failed to start fanout modules")

        startup_radio_task = asyncio.create_task(_startup_radio_connect_and_setup())
        app.state.startup_radio_task = startup_radio_task
        yield
    finally:
        logger.info("Shutting down")
        try:
            if startup_radio_task and not startup_radio_task.done():
                startup_radio_task.cancel()
                try:
                    await startup_radio_task
                except asyncio.CancelledError:
                    pass
            await radio_manager.stop_connection_monitor()
            from app.services.radio_lifecycle import cancel_radio_lifecycle

            await cancel_radio_lifecycle(radio_manager.manager)
            await radio_job_worker.stop()
            if unsubscribe_job is not None:
                unsubscribe_job()
            if unsubscribe_activity is not None:
                unsubscribe_activity()
            from app.services.radio_response_tracker import radio_response_tracker

            radio_response_tracker.shutdown()
            # Keep existing background teardown ordering. Never attempt to
            # acquire the radio lock if an uncooperative transport still owns it.
            from app.fanout.manager import fanout_manager

            await fanout_manager.stop_all()
            await stop_background_contact_reconciliation()
            await stop_message_polling()
            await stop_radio_stats_sampling()
            await stop_periodic_advert()
            await stop_periodic_sync()
            await stop_telemetry_collect()
            if not radio_job_worker.quarantined:
                if radio_manager.meshcore:
                    await radio_manager.meshcore.stop_auto_message_fetching()
                await radio_manager.disconnect()
            else:
                logger.critical("Radio worker quarantined: process restart required")
        finally:
            try:
                if database_open:
                    await db.disconnect()
            finally:
                # If a non-cooperative MeshCore task survived shutdown, retain
                # OS ownership until the OS terminates this process.
                if not radio_job_worker.quarantined:
                    radio_owner.release()


app = FastAPI(
    title="MESHRIK for MeshCore API",
    description=API_DESCRIPTION,
    version=get_app_build_info().version,
    openapi_tags=API_TAGS_METADATA,
    docs_url=None,
    lifespan=lifespan,
)

register_api_docs_routes(app)
add_optional_basic_auth_middleware(app, server_settings)
app.add_middleware(GZipMiddleware, minimum_size=500)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.exception_handler(RadioDisconnectedError)
async def radio_disconnected_handler(request: Request, exc: RadioDisconnectedError):
    """Return 423 when a radio disconnect race occurs during an operation."""
    return JSONResponse(status_code=423, content={"detail": "Radio not connected"})


@app.exception_handler(RadioOperationBusyError)
async def radio_operation_busy_handler(request: Request, exc: RadioOperationBusyError):
    """Return a bounded, retryable response when the legacy radio lock is occupied."""
    return JSONResponse(
        status_code=503,
        content={"detail": str(exc)},
        headers={"Retry-After": "5"},
    )


# OpenAPI path item keys that name HTTP operations.
_OPENAPI_OPERATION_KEYS = frozenset(
    {"get", "put", "post", "delete", "options", "head", "patch", "trace"}
)
_DOCUMENTED_ALLOW_METHODS_ATTR = "_documented_allow_methods"


def _compile_path_template(template: str) -> re.Pattern[str]:
    """Compile an OpenAPI path template (``/a/{id}``) into a matching regex."""
    segments = re.split(r"\{[^}]*\}", template)
    pattern = ""
    for index, segment in enumerate(segments):
        if index:
            pattern += "[^/]+"
        pattern += re.escape(segment)
    return re.compile(f"^{pattern}$")


def _request_route_path(scope: Scope) -> str:
    """Return the request path with any ASGI root_path mount prefix removed.

    OpenAPI path templates are registered without the mount prefix, and
    Starlette's own equivalent helper is not part of its public exports.
    """
    path = str(scope["path"])
    root_path = str(scope.get("root_path") or "")
    if not root_path or not path.startswith(root_path):
        return path
    if path == root_path:
        return ""
    if path[len(root_path)] == "/":
        return path[len(root_path) :]
    return path


def _documented_allow_methods(app: FastAPI) -> list[tuple[re.Pattern[str], set[str]]]:
    """Return compiled schema paths with the HTTP methods each one documents.

    Starlette answers an unsupported method (including ``OPTIONS``) from the
    first partial route match, so its ``Allow`` header only ever names that one
    route's methods. FastAPI registers same-path methods as separate routes, and
    since 0.143 wraps ``include_router()`` results instead of flattening them,
    walking ``app.routes`` no longer sees the API routes at all. The OpenAPI
    schema is the documented contract, so it is the source for the complete
    ``Allow`` set.
    """
    cached = getattr(app.state, _DOCUMENTED_ALLOW_METHODS_ATTR, None)
    if cached is None:
        cached = [
            (
                _compile_path_template(template),
                {method.upper() for method in operations if method in _OPENAPI_OPERATION_KEYS},
            )
            for template, operations in app.openapi().get("paths", {}).items()
        ]
        setattr(app.state, _DOCUMENTED_ALLOW_METHODS_ATTR, cached)
    return cached


@app.middleware("http")
async def log_server_errors(request: Request, call_next):
    """Capture 5xx errors and unhandled exceptions into the log ring buffer.

    Starlette writes unhandled-exception tracebacks to stderr, bypassing
    Python logging, so they never reach the debug dump.  This middleware
    catches them and logs via ``logger.exception()`` so the full traceback
    is preserved in the ring buffer for the ``GET /api/debug`` snapshot.
    """
    try:
        response = await call_next(request)
    except Exception:
        logger.exception("Unhandled exception on %s %s", request.method, request.url.path)
        raise
    if response.status_code >= 500:
        logger.error("HTTP %d on %s %s", response.status_code, request.method, request.url.path)
    elif response.status_code == 405:
        request_path = _request_route_path(request.scope)
        allowed_methods: set[str] = set()
        for pattern, methods in _documented_allow_methods(request.app):
            if pattern.match(request_path):
                allowed_methods.update(methods)
        if allowed_methods:
            response.headers["Allow"] = ", ".join(sorted(allowed_methods))
    return response


# API routes - all prefixed with /api for production compatibility
app.include_router(health.router, prefix="/api")
app.include_router(debug.router, prefix="/api")
app.include_router(fanout.router, prefix="/api")
app.include_router(radio.router, prefix="/api")
app.include_router(radio_jobs.router, prefix="/api")
app.include_router(contacts.router, prefix="/api")
app.include_router(repeaters.router, prefix="/api")
app.include_router(rooms.router, prefix="/api")
app.include_router(channels.router, prefix="/api")
app.include_router(messages.router, prefix="/api")
app.include_router(packets.router, prefix="/api")
app.include_router(read_state.router, prefix="/api")
app.include_router(settings.router, prefix="/api")
app.include_router(statistics.router, prefix="/api")
app.include_router(push.router, prefix="/api")
app.include_router(ws.router, prefix="/api")

# Serve frontend static files in production
FRONTEND_DIST_DIR = Path(__file__).parent.parent / "frontend" / "dist"
FRONTEND_PREBUILT_DIR = Path(__file__).parent.parent / "frontend" / "prebuilt"
if not register_first_available_frontend_static_routes(
    app, [FRONTEND_DIST_DIR, FRONTEND_PREBUILT_DIR]
):
    register_frontend_missing_fallback(app)
