from __future__ import annotations

import json

import pytest

from bw_stt.errors import ProtocolError
from bw_stt.events import (
    ErrorEvent,
    Segment,
    SessionClosed,
    SessionOpened,
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


def test_parse_error_event() -> None:
    event = parse_event('{"type":"Error","code":"invalid_frame","message":"bad duration"}')
    assert isinstance(event, ErrorEvent)
    assert event.code == "invalid_frame"
    assert event.message == "bad duration"


def test_parse_session_closed() -> None:
    event = parse_event(
        '{"type":"SessionClosed","request_id":"r","audio_duration_seconds":184.32,'
        '"session_duration_seconds":190.11}'
    )
    assert isinstance(event, SessionClosed)
    assert event.audio_duration_seconds == 184.32
    assert event.session_duration_seconds == 190.11


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
    }
    result = parse_transcription(json.dumps(payload))
    assert result.text == "hello"
    assert result.words[0].word == "hello"
    assert result.segments[0].text == "hello"
    assert result.segments[0].start == 0.0
    assert result.segments[0].end == 0.4
    assert result.audio_duration_seconds == 0.5
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


def test_parse_transcription_malformed() -> None:
    with pytest.raises(ProtocolError):
        parse_transcription('{"text":"missing fields"}')
    with pytest.raises(ProtocolError):
        parse_transcription("<html>")
