from __future__ import annotations

import json

import pytest

from bw_stt.errors import ProtocolError
from bw_stt.events import (
    ErrorEvent,
    RedactedEntity,
    RedactionSummary,
    Segment,
    SessionClosed,
    SessionOpened,
    Transcript,
    UnknownEvent,
    parse_event,
    parse_transcription,
)


def test_parse_session_opened() -> None:
    payload = {
        "type": "SessionOpened",
        "request_id": "6f58c1c6",
        "model_info": {"name": "bw-streaming-en", "version": "current"},
        "channels": 1,
        "sample_rate": 16000,
        "encoding": "linear16",
    }
    event = parse_event(json.dumps(payload))
    assert isinstance(event, SessionOpened)
    assert event.request_id == "6f58c1c6"
    assert event.model_name == "bw-streaming-en"
    assert event.model_version == "current"
    assert event.channels == 1
    assert event.sample_rate == 16000
    assert event.encoding == "linear16"
    assert event.raw == payload


def test_parse_segment_with_leading_space() -> None:
    payload = (
        '{"type":"Segment","channel":0,"start":0.24,"end":0.44,"text":" a dr",'
        '"words":[{"word":"a","start":0.24,"end":0.32},{"word":"dr","start":0.36,"end":0.44}]}'
    )
    event = parse_event(payload)
    assert isinstance(event, Segment)
    assert event.text == " a dr"
    assert event.text.startswith(" ")
    assert [w.word for w in event.words] == ["a", "dr"]
    assert event.words[1].start == 0.36
    assert event.raw == json.loads(payload)


def test_parse_segment_without_words_field() -> None:
    event = parse_event('{"type":"Segment","channel":0,"start":0,"end":0.2,"text":"hi"}')
    assert isinstance(event, Segment)
    assert event.words == ()


def test_parse_transcript_with_redaction_summary() -> None:
    payload = {
        "type": "Transcript",
        "channel": 1,
        "text": "hello",
        "words": [{"word": "hello", "start": 0.0, "end": 0.4}],
        "redaction": {"applied": True, "policies": ["ssn"], "entities_redacted": 1},
    }
    event = parse_event(json.dumps(payload))
    assert isinstance(event, Transcript)
    assert event.channel == 1
    assert event.text == "hello"
    assert event.words[0].word == "hello"
    assert event.redaction == RedactionSummary(True, ("ssn",), 1)
    assert event.raw == payload


def test_parse_transcript_with_redacted_entities() -> None:
    payload = {
        "type": "Transcript",
        "channel": 0,
        "text": "card hash:v1:9f2c41d08ab37e15",
        "words": [],
        "redaction": {"applied": True, "policies": ["credit_card"], "entities_redacted": 1},
        "redacted_entities": [
            {
                "token": "hash:v1:9f2c41d08ab37e15",
                "kind": "credit_card",
                "text": "4111 1111 1111 1111",
                "start": 0.5,
                "end": 1.2,
            }
        ],
    }
    event = parse_event(json.dumps(payload))
    assert isinstance(event, Transcript)
    assert event.redacted_entities == (
        RedactedEntity(
            token="hash:v1:9f2c41d08ab37e15",
            kind="credit_card",
            text="4111 1111 1111 1111",
            start=0.5,
            end=1.2,
        ),
    )


def test_parse_redacted_entity_missing_timestamps_as_none() -> None:
    event = parse_event(
        json.dumps(
            {
                "type": "Transcript",
                "channel": 0,
                "text": "hash:v1:abc",
                "words": [],
                "redaction": {"applied": True, "policies": ["ssn"], "entities_redacted": 1},
                "redacted_entities": [
                    {"token": "hash:v1:abc", "kind": "ssn", "text": "123-45-6789"}
                ],
            }
        )
    )
    assert isinstance(event, Transcript)
    assert event.redacted_entities is not None
    assert event.redacted_entities[0].start is None
    assert event.redacted_entities[0].end is None


def test_parse_redacted_entities_absent_and_empty() -> None:
    absent = parse_event(
        '{"type":"Transcript","channel":0,"text":"hello","words":[],'
        '"redaction":{"applied":false,"policies":[],"entities_redacted":0}}'
    )
    empty = parse_event(
        '{"type":"Transcript","channel":0,"text":"hello","words":[],'
        '"redaction":{"applied":false,"policies":[],"entities_redacted":0},'
        '"redacted_entities":[]}'
    )
    assert isinstance(absent, Transcript)
    assert isinstance(empty, Transcript)
    assert absent.redacted_entities is None
    assert empty.redacted_entities == ()


def test_parse_error_event() -> None:
    event = parse_event('{"type":"Error","code":"invalid_frame","message":"bad duration"}')
    assert isinstance(event, ErrorEvent)
    assert event.code == "invalid_frame"
    assert event.message == "bad duration"


def test_parse_transcript_too_large_as_error_event() -> None:
    event = parse_event('{"type":"Error","code":"transcript_too_large","message":"too large"}')
    assert isinstance(event, ErrorEvent)
    assert event.code == "transcript_too_large"


def test_parse_session_closed() -> None:
    event = parse_event(
        '{"type":"SessionClosed","request_id":"r","audio_duration_seconds":184.32,'
        '"session_duration_seconds":190.11}'
    )
    assert isinstance(event, SessionClosed)
    assert event.audio_duration_seconds == 184.32
    assert event.session_duration_seconds == 190.11
    assert not event.delivery_failed


def test_parse_failed_session_closed() -> None:
    event = parse_event(
        '{"type":"SessionClosed","request_id":"r","audio_duration_seconds":1,'
        '"session_duration_seconds":2,"delivery_failed":true}'
    )
    assert isinstance(event, SessionClosed)
    assert event.delivery_failed


def test_unknown_event_passthrough() -> None:
    event = parse_event('{"type":"Diarization","turns":[1,2]}')
    assert isinstance(event, UnknownEvent)
    assert event.type == "Diarization"
    assert event.raw == {"type": "Diarization", "turns": [1, 2]}


@pytest.mark.parametrize(
    "payload",
    [
        "not json",
        "[1,2]",
        '{"notype":1}',
        '{"type":"Segment","channel":"x","start":0,"end":0,"text":"t","words":[]}',
        '{"type":"SessionOpened","request_id":"r"}',
    ],
)
def test_malformed_messages_raise(payload: str) -> None:
    with pytest.raises(ProtocolError):
        parse_event(payload)


def test_parse_transcription() -> None:
    payload = {
        "request_id": "req-t",
        "text": "hello",
        "words": [{"word": "hello", "start": 0.0, "end": 0.4}],
        "segments": [{"start": 0.0, "end": 0.4, "text": "hello"}],
        "audio_duration_seconds": 0.5,
        "pii_entities": [{"kind": "ssn"}],
        "redacted_entities": [
            {
                "token": "hash:v1:9f2c41d08ab37e15",
                "kind": "credit_card",
                "text": "4111 1111 1111 1111",
                "start": 0.1,
                "end": 0.4,
            }
        ],
        "model_info": {"name": "bw-streaming-en", "version": "current"},
    }
    result = parse_transcription(json.dumps(payload))
    assert result.text == "hello"
    assert result.words[0].word == "hello"
    assert result.segments[0].text == "hello"
    assert result.segments[0].start == 0.0
    assert result.segments[0].end == 0.4
    assert result.audio_duration_seconds == 0.5
    assert result.model_info == {"name": "bw-streaming-en", "version": "current"}
    assert result.redacted_entities == (
        RedactedEntity(
            token="hash:v1:9f2c41d08ab37e15",
            kind="credit_card",
            text="4111 1111 1111 1111",
            start=0.1,
            end=0.4,
        ),
    )
    assert result.raw["pii_entities"] == [{"kind": "ssn"}]


def test_parse_transcription_allows_empty_words() -> None:
    result = parse_transcription(
        json.dumps(
            {
                "request_id": "req-t",
                "text": "hello",
                "words": [],
                "segments": [{"start": 0.0, "end": 0.4, "text": "hello"}],
                "audio_duration_seconds": 0.5,
                "model_info": {"name": "bw-streaming-en", "version": "current"},
            }
        )
    )
    assert result.words == ()
    assert result.segments[0].text == "hello"


def test_parse_transcription_redacted_entities_absent_and_empty() -> None:
    base = {
        "request_id": "req-t",
        "text": "hello",
        "words": [],
        "segments": [],
        "audio_duration_seconds": 0.5,
    }
    absent = parse_transcription(json.dumps(base))
    empty = parse_transcription(json.dumps({**base, "redacted_entities": []}))
    assert absent.redacted_entities is None
    assert empty.redacted_entities == ()


def test_parse_transcription_malformed() -> None:
    with pytest.raises(ProtocolError):
        parse_transcription('{"text":"missing fields"}')
    with pytest.raises(ProtocolError):
        parse_transcription("<html>")
