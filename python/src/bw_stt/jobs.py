"""Typed asynchronous transcription job models and response parsing."""

from __future__ import annotations

import json
import math
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Literal, cast

from .errors import ProtocolError
from .events import Transcription, parse_transcription

__all__ = [
    "JobErrorDetail",
    "JobStatus",
    "TranscriptionJob",
    "TranscriptionJobResult",
    "TranscriptionJobSubmission",
    "parse_job",
    "parse_job_status",
    "parse_job_submission",
]

JobStatus = Literal["queued", "processing", "completed", "error"]
TranscriptionJobResult = Transcription


@dataclass(frozen=True)
class JobErrorDetail:
    """The service error recorded when a job reaches the error state."""

    code: str
    message: str


@dataclass(frozen=True)
class TranscriptionJobSubmission:
    """The identifier and initial status returned after a job is submitted."""

    id: str
    status: JobStatus
    raw: dict[str, Any] = field(repr=False)


@dataclass(frozen=True)
class TranscriptionJob:
    """A point-in-time asynchronous transcription job status."""

    id: str
    status: JobStatus
    progress: float
    created_at: datetime
    updated_at: datetime
    result: Transcription | None
    error: JobErrorDetail | None
    raw: dict[str, Any] = field(repr=False)


def _object(payload: str | bytes, context: str) -> dict[str, Any]:
    try:
        value = json.loads(payload)
    except ValueError as exc:
        raise ProtocolError(f"{context} is not valid JSON") from exc
    if not isinstance(value, dict):
        raise ProtocolError(f"{context} is not a JSON object")
    return value


def _string(value: dict[str, Any], key: str, context: str) -> str:
    item = value.get(key)
    if not isinstance(item, str) or not item:
        raise ProtocolError(f"{context} is missing a non-empty {key}")
    return item


def parse_job_status(value: Any, context: str = "transcription job status") -> JobStatus:
    if value not in ("queued", "processing", "completed", "error"):
        raise ProtocolError(f"{context} is invalid")
    return cast(JobStatus, value)


def _progress(value: dict[str, Any]) -> float:
    progress = value.get("progress")
    if (
        isinstance(progress, bool)
        or not isinstance(progress, int | float)
        or not math.isfinite(progress)
    ):
        raise ProtocolError("transcription job progress is not a finite number")
    return float(progress)


def _datetime(value: dict[str, Any], key: str) -> datetime:
    raw = value.get(key)
    if not isinstance(raw, str):
        raise ProtocolError(f"transcription job {key} is not a timestamp")
    try:
        parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ProtocolError(f"transcription job {key} is not a timestamp") from exc
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed


def _job_error(value: Any) -> JobErrorDetail | None:
    if value is None:
        return None
    if not isinstance(value, dict):
        raise ProtocolError("transcription job error is not an object")
    return JobErrorDetail(
        code=_string(value, "code", "transcription job error"),
        message=_string(value, "message", "transcription job error"),
    )


def parse_job_submission(payload: str | bytes) -> TranscriptionJobSubmission:
    """Decode the 202 response from the job submission endpoint."""
    value = _object(payload, "transcription submission response")
    return TranscriptionJobSubmission(
        id=_string(value, "id", "transcription submission response"),
        status=parse_job_status(value.get("status"), "transcription submission status"),
        raw=value,
    )


def parse_job(payload: str | bytes) -> TranscriptionJob:
    """Decode one job status response."""
    value = _object(payload, "transcription job response")
    raw_result = value.get("result")
    if raw_result is None:
        result = None
    elif isinstance(raw_result, dict):
        result = parse_transcription(json.dumps(raw_result))
    else:
        raise ProtocolError("transcription job result is not an object")
    return TranscriptionJob(
        id=_string(value, "id", "transcription job response"),
        status=parse_job_status(value.get("status")),
        progress=_progress(value),
        created_at=_datetime(value, "created_at"),
        updated_at=_datetime(value, "updated_at"),
        result=result,
        error=_job_error(value.get("error")),
        raw=value,
    )
