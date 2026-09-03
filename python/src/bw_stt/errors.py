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
    "JobLimitError",
    "JobLimitReachedError",
    "JobPlatformUnavailableError",
    "NotFoundError",
    "ProtocolError",
    "RateLimitError",
    "ServiceUnavailableError",
    "TranscriptionJobError",
    "TranscriptionNotFoundError",
]


class BwSttError(Exception):
    """Base class for every error raised by this SDK."""


class AuthenticationError(BwSttError):
    """The API key was missing or rejected (HTTP 401 or 403)."""


class RateLimitError(BwSttError):
    """The request was rejected by a rate or concurrency limit (HTTP 429)."""

    def __init__(
        self, message: str, retry_after: float | None = None, code: str | None = None
    ) -> None:
        super().__init__(message)
        self.retry_after = retry_after
        """Seconds to wait before retrying, when the server supplied Retry-After."""
        self.code = code


class ServiceUnavailableError(BwSttError):
    """The service is temporarily unavailable (HTTP 5xx)."""


class JobLimitError(RateLimitError):
    """The per-key in-flight transcription job limit was reached."""

    code = "job_limit_reached"

    def __init__(self, message: str, retry_after: float | None = None) -> None:
        super().__init__(message, retry_after=retry_after, code=self.code)


JobLimitReachedError = JobLimitError


class JobPlatformUnavailableError(ServiceUnavailableError):
    """The asynchronous transcription job platform is unavailable."""

    code = "job_platform_unavailable"


class TranscriptionNotFoundError(BwSttError):
    """The requested transcription job does not exist for this API key."""

    code = "not_found"
    status = 404


NotFoundError = TranscriptionNotFoundError


class TranscriptionJobError(BwSttError):
    """A transcription job reached the terminal error state."""

    def __init__(self, code: str, message: str) -> None:
        self.code = code
        self.job_message = message
        self.message = message
        super().__init__(f"{code}: {message}")


class InvalidRequestError(BwSttError):
    """The server rejected the request as invalid (HTTP 400 or 413)."""

    def __init__(
        self, message: str, *, code: str | None = None, status: int | None = None
    ) -> None:
        super().__init__(message)
        self.code = code
        self.status = status


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
