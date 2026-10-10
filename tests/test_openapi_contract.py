"""Bounded, read-only Schemathesis checks for the public REST contract.

The allowlist is deliberately explicit. Add an operation only when its radio,
fanout, push, and database effects are isolated for generated inputs.
"""

import httpx
import pytest
import schemathesis
from hypothesis import HealthCheck, settings

from app.main import app as production_app
from app.models import AppSettings
from app.repository.channels import ChannelRepository
from app.repository.contacts import ContactRepository
from app.repository.messages import MessageRepository
from app.repository.settings import AppSettingsRepository
from app.routers import health

pytestmark = [
    pytest.mark.contract,
    pytest.mark.filterwarnings("ignore:There is no current event loop:DeprecationWarning"),
]


schema = schemathesis.openapi.from_dict(production_app.openapi())
schema.app = production_app
safe_read_schema = schema.include(
    method="GET",
    path=[
        "/api/health",
        "/api/contacts",
        "/api/channels",
        "/api/messages",
        "/api/read-state/unreads",
        "/api/settings",
    ],
)


@pytest.fixture(scope="module", autouse=True)
def isolated_read_repositories():
    """Replace database and health probes with deterministic in-memory results."""
    monkeypatch = pytest.MonkeyPatch()

    async def no_contacts(*args, **kwargs):
        return []

    async def no_channels(*args, **kwargs):
        return []

    async def default_settings(*args, **kwargs):
        return AppSettings()

    async def no_messages(*args, **kwargs):
        return []

    async def no_unreads(*args, **kwargs):
        return {
            "counts": {},
            "mentions": {},
            "last_message_times": {},
            "first_unread_ids": {},
            "last_read_ats": {},
        }

    async def healthy_without_runtime(*args, **kwargs):
        return {
            "status": "degraded",
            "radio_connected": False,
            "radio_initializing": False,
            "radio_state": "disconnected",
            "connection_info": None,
            "database_size_mb": 0.0,
            "oldest_undecrypted_timestamp": None,
        }

    monkeypatch.setattr(ContactRepository, "get_all", no_contacts)
    monkeypatch.setattr(ChannelRepository, "get_all", no_channels)
    monkeypatch.setattr(AppSettingsRepository, "get", default_settings)
    monkeypatch.setattr(MessageRepository, "get_all", no_messages)
    monkeypatch.setattr(MessageRepository, "get_unread_counts", no_unreads)
    monkeypatch.setattr(health, "build_health_data", healthy_without_runtime)
    yield
    monkeypatch.undo()


@safe_read_schema.parametrize()
@settings(
    max_examples=12,
    deadline=None,
    derandomize=True,
    suppress_health_check=[HealthCheck.too_slow],
)
async def test_safe_read_contract(case, isolated_read_repositories):
    """Validate documented status codes, content types, and response schemas."""
    # ASGITransport deliberately does not run lifespan events. Repository probes
    # are patched above, so no database, radio, or integration is started.
    transport = httpx.ASGITransport(app=production_app)
    request_kwargs = case.as_transport_kwargs(base_url="http://test")
    cookies = request_kwargs.pop("cookies", None)
    async with httpx.AsyncClient(transport=transport, cookies=cookies) as client:
        response = await client.request(**request_kwargs)
    case.validate_response(response)


@pytest.mark.parametrize(
    ("path", "query"),
    [
        ("/api/contacts", {"limit": 0}),
        ("/api/contacts", {"limit": 1001}),
        ("/api/messages", {"limit": "not-an-integer"}),
    ],
)
async def test_documented_query_boundaries_are_rejected(path, query, isolated_read_repositories):
    """Exercise malformed and out-of-range inputs through schema-owned cases."""
    case = schema[path]["GET"].Case(query=query)
    request_kwargs = case.as_transport_kwargs(base_url="http://test")
    cookies = request_kwargs.pop("cookies", None)
    transport = httpx.ASGITransport(app=production_app)
    async with httpx.AsyncClient(transport=transport, cookies=cookies) as client:
        response = await client.request(**request_kwargs)

    assert response.status_code == 422
    case.validate_response(response)
