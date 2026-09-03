"""Python SDK for the Bandwidth Labs speech-to-text API."""

from .aio import AsyncBwSttClient, AsyncSession
from .errors import (
    AuthenticationError,
    BwSttError,
    ConnectionClosedError,
    InvalidRequestError,
    JobLimitError,
    JobLimitReachedError,
    JobPlatformUnavailableError,
    NotFoundError,
    ProtocolError,
    RateLimitError,
    ServiceUnavailableError,
    TranscriptionJobError,
    TranscriptionNotFoundError,
)
from .events import (
    ErrorEvent,
    Event,
    RedactedEntity,
    RedactionSummary,
    Segment,
    SessionClosed,
    SessionOpened,
    Transcript,
    Transcription,
    TranscriptionChannel,
    TranscriptionSegment,
    UnknownEvent,
    Word,
)
from .jobs import (
    JobErrorDetail,
    JobStatus,
    TranscriptionJob,
    TranscriptionJobResult,
    TranscriptionJobSubmission,
)
from .sync import BwSttClient, Session
from .transcript import DisplayWord, TranscriptAssembler, WordAssembler
from .transcriptions import AsyncTranscriptionsClient, TranscriptionsClient

__version__ = "0.1.0"

__all__ = [
    "AsyncBwSttClient",
    "AsyncSession",
    "AsyncTranscriptionsClient",
    "AuthenticationError",
    "BwSttClient",
    "BwSttError",
    "ConnectionClosedError",
    "DisplayWord",
    "ErrorEvent",
    "Event",
    "InvalidRequestError",
    "JobErrorDetail",
    "JobLimitError",
    "JobLimitReachedError",
    "JobPlatformUnavailableError",
    "JobStatus",
    "NotFoundError",
    "ProtocolError",
    "RateLimitError",
    "RedactedEntity",
    "RedactionSummary",
    "Segment",
    "ServiceUnavailableError",
    "Session",
    "SessionClosed",
    "SessionOpened",
    "Transcript",
    "TranscriptAssembler",
    "Transcription",
    "TranscriptionChannel",
    "TranscriptionJob",
    "TranscriptionJobError",
    "TranscriptionJobResult",
    "TranscriptionJobSubmission",
    "TranscriptionNotFoundError",
    "TranscriptionSegment",
    "TranscriptionsClient",
    "UnknownEvent",
    "Word",
    "WordAssembler",
    "__version__",
]
