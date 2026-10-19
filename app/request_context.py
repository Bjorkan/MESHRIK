"""Request-scoped diagnostic correlation without retaining request payloads."""

from contextvars import ContextVar, Token
from uuid import uuid4

from starlette.types import ASGIApp, Message, Receive, Scope, Send

_request_id: ContextVar[str | None] = ContextVar("request_id", default=None)


def get_request_id() -> str:
    """Return the current opaque request identifier, or ``-`` outside HTTP."""
    return _request_id.get() or "-"


def set_request_id(request_id: str) -> Token[str | None]:
    """Bind an application-generated identifier to the current async context."""
    return _request_id.set(request_id)


def reset_request_id(token: Token[str | None]) -> None:
    """Restore the previous request context."""
    _request_id.reset(token)


class RequestContextMiddleware:
    """Add an opaque response ID while preserving ContextVar propagation."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        request_id = uuid4().hex
        token = set_request_id(request_id)

        async def send_with_request_id(message: Message) -> None:
            if message["type"] == "http.response.start":
                headers = list(message.get("headers", []))
                headers.append((b"x-request-id", request_id.encode("ascii")))
                message = {**message, "headers": headers}
            await send(message)

        try:
            await self.app(scope, receive, send_with_request_id)
        finally:
            reset_request_id(token)
