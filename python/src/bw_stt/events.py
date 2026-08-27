"""Typed events and results received from the service."""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any, TypeAlias

from .errors import ProtocolError

__all__ = [
    "ErrorEvent",
    "Event",
    "RedactedEntity",
    "RedactionSummary",
    "Segment",
    "SessionClosed",
    "SessionOpened",
    "Transcript",
    "Transcription",
    "TranscriptionSegment",
    "UnknownEvent",
    "Word",
    "parse_event",
    "parse_transcription",
]


@dataclass(frozen=True)
class Word:
    """One word piece with timestamps in seconds."""

    word: str
    start: float
    end: float


@dataclass(frozen=True)
class Segment:
    """A final transcript delta; segments are append-only and never revised.

    ``text`` concatenates verbatim across segments: a segment whose text
    starts with a space begins a new word, one without a leading space
    continues the previous word.
    """

    channel: int
    start: float
    end: float
    text: str
    words: tuple[Word, ...]
    raw: dict[str, Any] = field(repr=False)


@dataclass(frozen=True)
class RedactionSummary:
    """PII redaction information attached to a demand-mode transcript."""

    applied: bool
    policies: tuple[str, ...]
    entities_redacted: int


@dataclass(frozen=True)
class RedactedEntity:
    """One PII span returned when redaction entity return is enabled."""

    token: str
    kind: str
    text: str
    start: float | None
    end: float | None


@dataclass(frozen=True)
class Transcript:
    """A complete demand-mode transcript for one channel."""

    channel: int
    text: str
    words: tuple[Word, ...]
    redaction: RedactionSummary
    raw: dict[str, Any] = field(repr=False)
    redacted_entities: tuple[RedactedEntity, ...] | None = None


@dataclass(frozen=True)
class SessionOpened:
    """First event of a session, sent after a successful upgrade."""

    request_id: str
    model_name: str
    model_version: str
    channels: int
    sample_rate: int
    encoding: str
    raw: dict[str, Any] = field(repr=False)


@dataclass(frozen=True)
class SessionClosed:
    """Terminal event of a graceful close; carries the usage echo."""

    request_id: str
    audio_duration_seconds: float
    session_duration_seconds: float
    raw: dict[str, Any] = field(repr=False)
    delivery_failed: bool = False


@dataclass(frozen=True)
class ErrorEvent:
    """An in-band protocol error reported by the server."""

    code: str
    message: str
    raw: dict[str, Any] = field(repr=False)


@dataclass(frozen=True)
class UnknownEvent:
    """An event type this SDK does not know; surfaced for forward compatibility."""

    type: str
    raw: dict[str, Any] = field(repr=False)


@dataclass(frozen=True)
class TranscriptionSegment:
    """One timestamped segment in an offline transcription result."""

    start: float
    end: float
    text: str


@dataclass(frozen=True)
class Transcription:
    """Result of an offline transcribe request."""

    request_id: str
    text: str
    words: tuple[Word, ...]
    segments: tuple[TranscriptionSegment, ...]
    audio_duration_seconds: float
    model_info: dict[str, Any]
    raw: dict[str, Any] = field(repr=False)
    redacted_entities: tuple[RedactedEntity, ...] | None = None


Event: TypeAlias = SessionOpened | Segment | Transcript | ErrorEvent | SessionClosed | UnknownEvent


def _string(obj: dict[str, Any], key: str) -> str:
    value = obj.get(key)
    if not isinstance(value, str):
        raise ProtocolError(f"expected string {key!r} in server message")
    return value


def _integer(obj: dict[str, Any], key: str) -> int:
    value = obj.get(key)
    if isinstance(value, bool) or not isinstance(value, int):
        raise ProtocolError(f"expected integer {key!r} in server message")
    return value


def _number(obj: dict[str, Any], key: str) -> float:
    value = obj.get(key)
    if isinstance(value, bool) or not isinstance(value, int | float):
        raise ProtocolError(f"expected number {key!r} in server message")
    return float(value)


def _optional_number(obj: dict[str, Any], key: str) -> float | None:
    value = obj.get(key)
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int | float):
        raise ProtocolError(f"expected number or null {key!r} in server message")
    return float(value)


def _boolean(obj: dict[str, Any], key: str, *, default: bool | None = None) -> bool:
    value = obj.get(key, default)
    if not isinstance(value, bool):
        raise ProtocolError(f"expected boolean {key!r} in server message")
    return value


def _words(obj: dict[str, Any]) -> tuple[Word, ...]:
    raw_words = obj.get("words", [])
    if not isinstance(raw_words, list):
        raise ProtocolError("expected array 'words' in server message")
    words = []
    for item in raw_words:
        if not isinstance(item, dict):
            raise ProtocolError("expected object entries in 'words'")
        words.append(Word(_string(item, "word"), _number(item, "start"), _number(item, "end")))
    return tuple(words)


def _redaction(obj: dict[str, Any]) -> RedactionSummary:
    value = obj.get("redaction")
    if not isinstance(value, dict):
        raise ProtocolError("Transcript has no 'redaction' object")
    applied = _boolean(value, "applied")
    raw_policies = value.get("policies")
    if not isinstance(raw_policies, list) or not all(
        isinstance(policy, str) for policy in raw_policies
    ):
        raise ProtocolError("expected string array 'redaction.policies' in server message")
    entities_redacted = value.get("entities_redacted")
    if isinstance(entities_redacted, bool) or not isinstance(entities_redacted, int):
        raise ProtocolError("expected integer 'redaction.entities_redacted' in server message")
    return RedactionSummary(
        applied=applied,
        policies=tuple(raw_policies),
        entities_redacted=entities_redacted,
    )


def _redacted_entities(obj: dict[str, Any]) -> tuple[RedactedEntity, ...] | None:
    if "redacted_entities" not in obj:
        return None
    raw_entities = obj["redacted_entities"]
    if not isinstance(raw_entities, list):
        raise ProtocolError("expected array 'redacted_entities' in server message")
    entities = []
    for item in raw_entities:
        if not isinstance(item, dict):
            raise ProtocolError("expected object entries in 'redacted_entities'")
        entities.append(
            RedactedEntity(
                token=_string(item, "token"),
                kind=_string(item, "kind"),
                text=_string(item, "text"),
                start=_optional_number(item, "start"),
                end=_optional_number(item, "end"),
            )
        )
    return tuple(entities)


def _transcription_segments(obj: dict[str, Any]) -> tuple[TranscriptionSegment, ...]:
    raw_segments = obj.get("segments", [])
    if not isinstance(raw_segments, list):
        raise ProtocolError("expected array 'segments' in transcribe response")
    segments = []
    for item in raw_segments:
        if not isinstance(item, dict):
            raise ProtocolError("expected object entries in 'segments'")
        segments.append(
            TranscriptionSegment(
                start=_number(item, "start"),
                end=_number(item, "end"),
                text=_string(item, "text"),
            )
        )
    return tuple(segments)


def parse_event(payload: str | bytes) -> Event:
    """Decode one server text message into a typed event.

    Unknown event types become :class:`UnknownEvent`; malformed messages
    raise :class:`ProtocolError`.
    """
    try:
        value = json.loads(payload)
    except ValueError as exc:
        raise ProtocolError("server message is not valid JSON") from exc
    if not isinstance(value, dict):
        raise ProtocolError("server message is not a JSON object")
    event_type = value.get("type")
    if not isinstance(event_type, str):
        raise ProtocolError("server message has no 'type'")
    if event_type == "SessionOpened":
        model_info = value.get("model_info")
        if not isinstance(model_info, dict):
            raise ProtocolError("SessionOpened has no 'model_info'")
        return SessionOpened(
            request_id=_string(value, "request_id"),
            model_name=_string(model_info, "name"),
            model_version=_string(model_info, "version"),
            channels=_integer(value, "channels"),
            sample_rate=_integer(value, "sample_rate"),
            encoding=_string(value, "encoding"),
            raw=value,
        )
    if event_type == "Segment":
        return Segment(
            channel=_integer(value, "channel"),
            start=_number(value, "start"),
            end=_number(value, "end"),
            text=_string(value, "text"),
            words=_words(value),
            raw=value,
        )
    if event_type == "Transcript":
        return Transcript(
            channel=_integer(value, "channel"),
            text=_string(value, "text"),
            words=_words(value),
            redaction=_redaction(value),
            raw=value,
            redacted_entities=_redacted_entities(value),
        )
    if event_type == "Error":
        return ErrorEvent(code=_string(value, "code"), message=_string(value, "message"), raw=value)
    if event_type == "SessionClosed":
        return SessionClosed(
            request_id=_string(value, "request_id"),
            audio_duration_seconds=_number(value, "audio_duration_seconds"),
            session_duration_seconds=_number(value, "session_duration_seconds"),
            delivery_failed=_boolean(value, "delivery_failed", default=False),
            raw=value,
        )
    return UnknownEvent(type=event_type, raw=value)


def parse_transcription(payload: str | bytes) -> Transcription:
    """Decode the JSON body of a successful transcribe response."""
    try:
        value = json.loads(payload)
    except ValueError as exc:
        raise ProtocolError("transcribe response is not valid JSON") from exc
    if not isinstance(value, dict):
        raise ProtocolError("transcribe response is not a JSON object")
    model_info = value.get("model_info", {})
    if not isinstance(model_info, dict):
        raise ProtocolError("transcribe response model_info is not an object")
    return Transcription(
        request_id=_string(value, "request_id"),
        text=_string(value, "text"),
        words=_words(value),
        segments=_transcription_segments(value),
        audio_duration_seconds=_number(value, "audio_duration_seconds"),
        model_info=model_info,
        raw=value,
        redacted_entities=_redacted_entities(value),
    )
