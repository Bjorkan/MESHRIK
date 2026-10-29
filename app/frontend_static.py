import logging
import re
from html import escape
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

logger = logging.getLogger(__name__)

INDEX_CACHE_CONTROL = "no-store"
ASSET_CACHE_CONTROL = "public, max-age=31536000, immutable"
STATIC_FILE_CACHE_CONTROL = "public, max-age=3600"
FRONTEND_BUILD_INSTRUCTIONS = (
    "Run 'cd frontend && npm install && npm run build', "
    "or use a release zip that includes frontend/prebuilt."
)


class CacheControlStaticFiles(StaticFiles):
    """StaticFiles variant that adds a fixed Cache-Control header."""

    def __init__(self, *args, cache_control: str, **kwargs) -> None:
        super().__init__(*args, **kwargs)
        self.cache_control = cache_control

    def file_response(self, *args, **kwargs):
        response = super().file_response(*args, **kwargs)
        response.headers["Cache-Control"] = self.cache_control
        return response


def _file_response(path: Path, *, cache_control: str) -> FileResponse:
    return FileResponse(path, headers={"Cache-Control": cache_control})


def _is_index_file(path: Path, index_file: Path) -> bool:
    """Return True when the requested file is the SPA shell index.html."""
    return path == index_file


# Only Supervisor's X-Ingress-Path, not generic X-Forwarded-Prefix, is used
# to select Home Assistant's dynamic session URL. Never reflect arbitrary
# header bytes (HTML, query strings, encoded separators) into an HTML <base>.
_INGRESS_PATH_RE = re.compile(r"^/api/hassio_ingress/[A-Za-z0-9_-]+/?$")


def _request_app_path(request: Request) -> str:
    ingress = request.headers.get("x-ingress-path", "")
    if _INGRESS_PATH_RE.fullmatch(ingress):
        return ingress.rstrip("/") + "/"
    return "/"


def _serve_index(index_file: Path, request: Request) -> HTMLResponse:
    # The Vite build uses relative asset URLs. Fix their resolution on SPA
    # deep links, and expose exactly one canonical app base to JS and router.
    base = escape(_request_app_path(request), quote=True)
    html = index_file.read_text(encoding="utf-8")
    html = html.replace("<head>", f'<head><base href="{base}">', 1)
    if base != "/":
        # Home Assistant's origin is not the app's own PWA installation origin.
        html = re.sub(r'<link rel="manifest"[^>]*>', "", html, count=1)
    return HTMLResponse(html, headers={"Cache-Control": INDEX_CACHE_CONTROL})


def _resolve_request_base(request: Request) -> str:
    """Resolve the external origin and app base, honoring ingress and forwarded headers."""
    forwarded_proto = request.headers.get("x-forwarded-proto")
    forwarded_host = request.headers.get("x-forwarded-host")

    if forwarded_proto and forwarded_host:
        proto = forwarded_proto.split(",")[0].strip()
        host = forwarded_host.split(",")[0].strip()
        if proto and host:
            origin = f"{proto}://{host}"
        else:
            origin = str(request.base_url).rstrip("/")
    else:
        origin = str(request.base_url).rstrip("/")

    return f"{origin}{_request_app_path(request)}"


def _validate_frontend_dir(frontend_dir: Path, *, log_failures: bool = True) -> tuple[bool, Path]:
    """Resolve and validate a built frontend directory."""
    frontend_dir = frontend_dir.resolve()
    index_file = frontend_dir / "index.html"

    if not frontend_dir.exists():
        if log_failures:
            logger.error("Frontend build directory not found at %s.", frontend_dir)
        return False, frontend_dir

    if not frontend_dir.is_dir():
        if log_failures:
            logger.error("Frontend build path is not a directory: %s.", frontend_dir)
        return False, frontend_dir

    if not index_file.exists():
        if log_failures:
            logger.error("Frontend index file not found at %s.", index_file)
        return False, frontend_dir

    return True, frontend_dir


def register_frontend_static_routes(app: FastAPI, frontend_dir: Path) -> bool:
    """Register frontend static file routes if a built frontend is available."""
    valid, frontend_dir = _validate_frontend_dir(frontend_dir)
    if not valid:
        return False

    index_file = frontend_dir / "index.html"
    assets_dir = frontend_dir / "assets"

    if assets_dir.exists() and assets_dir.is_dir():
        app.mount(
            "/assets",
            CacheControlStaticFiles(directory=assets_dir, cache_control=ASSET_CACHE_CONTROL),
            name="assets",
        )
    else:
        logger.warning(
            "Frontend assets directory missing at %s; /assets files will not be served",
            assets_dir,
        )

    @app.get("/", include_in_schema=False)
    async def serve_index(request: Request):
        """Serve the frontend index.html."""
        return _serve_index(index_file, request)

    @app.get("/site.webmanifest", include_in_schema=False)
    async def serve_webmanifest(request: Request):
        """Serve a dynamic web manifest using the active request base URL."""
        base = _resolve_request_base(request)
        manifest = {
            "name": "MESHRIK for MeshCore",
            "short_name": "MESHRIK",
            "id": base,
            "start_url": base,
            "scope": base,
            "display": "standalone",
            "display_override": ["window-controls-overlay", "standalone", "fullscreen"],
            "theme_color": "#111419",
            "background_color": "#111419",
            # Icons are PNG-only on purpose. iOS Safari's manifest parser has
            # historically been unreliable with SVG icons, and Android/Chrome
            # PWA install flows prefer PNG for the install prompt.
            #
            # The "any" purpose entries are what iOS and desktop Chrome use
            # for the home-screen / install icon. "maskable" entries are
            # Android-only (adaptive icon with safe-zone crop); iOS does not
            # apply the safe-zone mask, so a maskable-only icon set would
            # render with excessive padding.
            "icons": [
                {
                    "src": f"{base}favicon-96x96.png",
                    "sizes": "96x96",
                    "type": "image/png",
                    "purpose": "any",
                },
                {
                    "src": f"{base}apple-touch-icon.png",
                    "sizes": "180x180",
                    "type": "image/png",
                    "purpose": "any",
                },
                {
                    "src": f"{base}favicon-256x256.png",
                    "sizes": "256x256",
                    "type": "image/png",
                    "purpose": "any",
                },
                {
                    "src": f"{base}web-app-manifest-192x192.png",
                    "sizes": "192x192",
                    "type": "image/png",
                    "purpose": "maskable",
                },
                {
                    "src": f"{base}web-app-manifest-512x512.png",
                    "sizes": "512x512",
                    "type": "image/png",
                    "purpose": "maskable",
                },
            ],
            "screenshots": [
                {
                    "src": f"{base}screenshot-wide.png",
                    "sizes": "1367x909",
                    "type": "image/png",
                    "form_factor": "wide",
                    "label": "MESHRIK desktop view",
                },
                {
                    "src": f"{base}screenshot-mobile.png",
                    "sizes": "1170x2532",
                    "type": "image/png",
                    "label": "MESHRIK mobile view",
                },
                {
                    "src": f"{base}screenshot-mobile-2.png",
                    "sizes": "750x1334",
                    "type": "image/png",
                    "label": "MESHRIK mobile conversation",
                },
            ],
        }
        return JSONResponse(
            manifest,
            media_type="application/manifest+json",
            headers={"Cache-Control": "no-store"},
        )

    @app.get("/{path:path}", include_in_schema=False)
    async def serve_frontend(path: str, request: Request):
        """Serve frontend files, falling back to index.html for SPA routing."""
        if path == "api" or path.startswith("api/"):
            return JSONResponse(
                status_code=404,
                content={
                    "detail": (
                        "API endpoint not found. If you are seeing this in response to a "
                        "frontend request, you may be running a newer frontend with an older "
                        "backend or vice versa. A full update is suggested."
                    )
                },
            )

        file_path = (frontend_dir / path).resolve()
        try:
            file_path.relative_to(frontend_dir)
        except ValueError:
            raise HTTPException(status_code=404, detail="Not found") from None

        if file_path.exists() and file_path.is_file():
            if _is_index_file(file_path, index_file):
                return _serve_index(index_file, request)
            return _file_response(file_path, cache_control=STATIC_FILE_CACHE_CONTROL)

        return _serve_index(index_file, request)

    logger.info("Serving frontend from %s", frontend_dir)
    return True


def register_first_available_frontend_static_routes(
    app: FastAPI, frontend_dirs: list[Path]
) -> Path | None:
    """Register frontend routes from the first valid build directory."""
    for i, candidate in enumerate(frontend_dirs):
        valid, resolved_candidate = _validate_frontend_dir(candidate, log_failures=False)
        if not valid:
            continue

        if register_frontend_static_routes(app, resolved_candidate):
            logger.info("Selected frontend build directory %s", resolved_candidate)
            return resolved_candidate

        if i < len(frontend_dirs) - 1:
            logger.warning("Frontend build at %s was unusable; trying fallback", resolved_candidate)

    logger.error(
        "No usable frontend build found. Searched: %s. %s API will continue without frontend routes.",
        ", ".join(str(path.resolve()) for path in frontend_dirs),
        FRONTEND_BUILD_INSTRUCTIONS,
    )
    return None


def register_frontend_missing_fallback(app: FastAPI) -> None:
    """Register a fallback route that tells the user to build the frontend."""

    @app.get("/", include_in_schema=False)
    async def frontend_not_built():
        return JSONResponse(
            status_code=404,
            content={"detail": f"Frontend not built. {FRONTEND_BUILD_INSTRUCTIONS}"},
        )
