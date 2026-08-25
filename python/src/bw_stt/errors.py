"""Exceptions raised by this SDK."""

from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .events import ErrorEvent

__all__ = [
    "AuthenticationError",
    "BwSttError",
    "ConnectionClosedError",
    "InvalidRequestError",
    "ProtocolError",
    "RateLimitError",
    "ServiceUnavailableError",
]


class BwSttError(Exception):
    """Base class for every error raised by this SDK."""


class AuthenticationError(BwSttError):
    """The API key was missing or rejected (HTTP 401 or 403)."""


class RateLimitError(BwSttError):
    """The request was rejected by a rate or concurrency limit (HTTP 429)."""

    def __init__(self, message: str, retry_after: float | None = None) -> None:
        super().__init__(message)
        self.retry_after = retry_after
        """Seconds to wait before retrying, when the server supplied Retry-After."""


class ServiceUnavailableError(BwSttError):
    """The service is temporarily unavailable (HTTP 5xx)."""


class InvalidRequestError(BwSttError):
    """The server rejected the request as invalid (HTTP 400 or 413)."""


class ConnectionClosedError(BwSttError):
    """The connection closed before the protocol reached SessionClosed.

    When the server sent an in-band Error event before closing, it is
    attached as ``error_event``.
    """

    def __init__(self, message: str, error_event: ErrorEvent | None = None) -> None:
        if error_event is not None:
            message = f"{message}: {error_event.code}: {error_event.message}"
        super().__init__(message)
        self.error_event = error_event


class ProtocolError(BwSttError):
    """The server sent a message this SDK cannot interpret."""
