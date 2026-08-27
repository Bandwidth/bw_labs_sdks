"""Python SDK for the Bandwidth Labs speech-to-text API."""

from .aio import AsyncBwSttClient, AsyncSession
from .errors import (
    AuthenticationError,
    BwSttError,
    ConnectionClosedError,
    InvalidRequestError,
    ProtocolError,
    RateLimitError,
    ServiceUnavailableError,
)
from .events import (
    ErrorEvent,
    Event,
    Segment,
    SessionClosed,
    SessionOpened,
    Transcription,
    TranscriptionSegment,
    UnknownEvent,
    Word,
)
from .sync import BwSttClient, Session
from .transcript import DisplayWord, TranscriptAssembler, WordAssembler

__version__ = "0.1.0"

__all__ = [
    "AsyncBwSttClient",
    "AsyncSession",
    "AuthenticationError",
    "BwSttClient",
    "BwSttError",
    "ConnectionClosedError",
    "DisplayWord",
    "ErrorEvent",
    "Event",
    "InvalidRequestError",
    "ProtocolError",
    "RateLimitError",
    "Segment",
    "ServiceUnavailableError",
    "Session",
    "SessionClosed",
    "SessionOpened",
    "TranscriptAssembler",
    "Transcription",
    "TranscriptionSegment",
    "UnknownEvent",
    "Word",
    "WordAssembler",
    "__version__",
]
