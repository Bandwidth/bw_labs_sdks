from __future__ import annotations

import time
from collections.abc import Iterator
from datetime import datetime, timedelta, timezone
from email.utils import format_datetime
from pathlib import Path
from urllib.parse import parse_qsl, urlsplit

import pytest

from bw_stt import (
    AuthenticationError,
    BwSttClient,
    ConnectionClosedError,
    ErrorEvent,
    RateLimitError,
    Segment,
    ServiceUnavailableError,
    SessionClosed,
    TranscriptAssembler,
    UnknownEvent,
)

from .conftest import ServerFactory, wait_until, write_wav
from .mocks import DOC_SEGMENTS, Script

AUDIO_160MS = b"\0" * 5120


def test_connect_sends_header_auth_and_params(mock_server: ServerFactory, api_key_env: str) -> None:
    server = mock_server()
    client = BwSttClient(api_key="bwa_key_explicit", base_url=server.url)
    with client.connect(mode="demand", keywords=["dry van"]) as session:
        assert session.opened.request_id == "req-1"
        assert session.opened.model_name == "bw-streaming-en"
    assert server.recorder.headers["x-bw-labs-api-key"] == "bwa_key_explicit"
    assert server.recorder.path is not None
    query = dict(parse_qsl(urlsplit(server.recorder.path).query))
    assert query["encoding"] == "linear16"
    assert query["sample_rate"] == "16000"
    assert query["channels"] == "1"
    assert query["mode"] == "demand"
    assert query["keywords"] == "dry van"


def test_api_key_env_fallback(mock_server: ServerFactory, api_key_env: str) -> None:
    server = mock_server()
    client = BwSttClient(base_url=server.url)
    with client.connect():
        pass
    assert server.recorder.headers["x-bw-labs-api-key"] == api_key_env


def test_missing_api_key(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("BW_STT_API_KEY", raising=False)
    client = BwSttClient()
    with pytest.raises(AuthenticationError, match="BW_STT_API_KEY"):
        client.connect()


def test_close_stream_returns_billing_and_drains(
    mock_server: ServerFactory, api_key_env: str
) -> None:
    server = mock_server()
    client = BwSttClient(base_url=server.url)
    transcript = TranscriptAssembler()
    session = client.connect()
    session.on_segment(transcript.push)
    session.send_audio(AUDIO_160MS)
    closed = session.close_stream()
    assert closed.audio_duration_seconds == pytest.approx(0.16)
    assert closed.session_duration_seconds == 1.0
    assert closed.request_id == "req-1"
    assert transcript.text == "i need a dry van"
    assert not session.is_open


def test_send_audio_validates_frames(mock_server: ServerFactory, api_key_env: str) -> None:
    server = mock_server()
    client = BwSttClient(base_url=server.url)
    with client.connect() as session:
        with pytest.raises(ValueError, match="at least"):
            session.send_audio(b"\0" * 100)
        with pytest.raises(ValueError, match="at most"):
            session.send_audio(b"\0" * 40000)
        with pytest.raises(ValueError, match="complete"):
            session.send_audio(b"\0" * 641)
        session.send_audio(AUDIO_160MS)
    assert server.recorder.frames == [AUDIO_160MS]


def test_stream_chunks_frames_and_tail(mock_server: ServerFactory, api_key_env: str) -> None:
    script = Script(segments_per_frame={1: [dict(DOC_SEGMENTS[0])]})
    server = mock_server(script)
    client = BwSttClient(base_url=server.url)

    with client.connect() as session:

        def chunks() -> Iterator[bytes]:
            yield b"\0" * 3000
            yield b"\0" * 7000  # completes frame 1; the server responds with a segment
            wait_until(lambda: session._inner._queue.qsize() >= 1)  # segment delivered
            yield b"\0" * 6000  # 16,000 bytes total = 500 ms

        segments = list(session.stream_chunks(chunks()))
    assert [len(f) for f in server.recorder.frames] == [5120, 5120, 5120, 640]
    assert len(segments) == 1
    assert segments[0].text == "i need"


def test_stream_chunks_short_leftover_raises(mock_server: ServerFactory, api_key_env: str) -> None:
    server = mock_server()
    client = BwSttClient(base_url=server.url)
    session = client.connect()
    with pytest.raises(ValueError, match="20 ms"):
        list(session.stream_chunks([b"\0" * (5120 + 100)]))
    session.close()


def test_stream_chunks_rejected_for_opus(mock_server: ServerFactory, api_key_env: str) -> None:
    server = mock_server()
    client = BwSttClient(base_url=server.url)
    session = client.connect(encoding="opus")
    with pytest.raises(ValueError, match=r"[Oo]pus"):
        session.stream_chunks([b"\x01"])
    session.close()


def test_stream_file_wav(mock_server: ServerFactory, api_key_env: str, wav_file: Path) -> None:
    server = mock_server()
    client = BwSttClient(base_url=server.url)
    with client.connect() as session:
        list(session.stream_file(wav_file))
        closed = session.close_stream()
    assert closed.audio_duration_seconds == pytest.approx(0.5)
    assert [len(f) for f in server.recorder.frames] == [5120, 5120, 5120, 640]


def test_stream_file_wav_header_mismatch(
    mock_server: ServerFactory, api_key_env: str, tmp_path: Path
) -> None:
    path = tmp_path / "slow.wav"
    write_wav(path, seconds=0.5, sample_rate=8000)
    server = mock_server()
    client = BwSttClient(base_url=server.url)
    session = client.connect()
    with pytest.raises(ValueError, match="8000 Hz"):
        session.stream_file(path)
    session.close()


def test_stream_file_raw(mock_server: ServerFactory, api_key_env: str, tmp_path: Path) -> None:
    path = tmp_path / "audio.pcm"
    path.write_bytes(b"\0" * 16000)
    server = mock_server()
    client = BwSttClient(base_url=server.url)
    with client.connect() as session:
        list(session.stream_file(path, raw=True))
    assert server.recorder.audio_bytes == 16000


def test_events_iteration(mock_server: ServerFactory, api_key_env: str) -> None:
    closed_event = {
        "type": "SessionClosed",
        "request_id": "req-1",
        "audio_duration_seconds": 1.28,
        "session_duration_seconds": 2.0,
    }
    script = Script(after_open=[*(dict(s) for s in DOC_SEGMENTS), closed_event])
    server = mock_server(script)
    client = BwSttClient(base_url=server.url)
    session = client.connect()
    events = list(session.events())
    assert [type(e).__name__ for e in events] == [
        "Segment",
        "Segment",
        "Segment",
        "SessionClosed",
    ]
    last = events[-1]
    assert isinstance(last, SessionClosed)
    assert last.audio_duration_seconds == 1.28
    session.close()


def test_finalize_flushes_segments(mock_server: ServerFactory, api_key_env: str) -> None:
    script = Script(on_finalize=[dict(Script().on_close[0])], on_close=[])
    server = mock_server(script)
    client = BwSttClient(base_url=server.url)
    with client.connect() as session:
        session.send_audio(AUDIO_160MS)
        session.finalize()
        event = next(iter(session.events()))
    assert isinstance(event, Segment)
    assert event.text == "i need"


def test_error_event_then_close_carries_error(mock_server: ServerFactory, api_key_env: str) -> None:
    script = Script(
        after_open=[{"type": "Error", "code": "idle_timeout", "message": "no audio"}],
        close_after_open_events=True,
    )
    server = mock_server(script)
    client = BwSttClient(base_url=server.url)
    session = client.connect()
    events = session.events()
    event = next(events)
    assert isinstance(event, ErrorEvent)
    assert event.code == "idle_timeout"
    with pytest.raises(ConnectionClosedError) as excinfo:
        next(events)
    assert excinfo.value.error_event is event
    assert "idle_timeout" in str(excinfo.value)


def test_unknown_event_passthrough(mock_server: ServerFactory, api_key_env: str) -> None:
    script = Script(after_open=[{"type": "Diarization", "turns": []}])
    server = mock_server(script)
    client = BwSttClient(base_url=server.url)
    session = client.connect()
    event = next(iter(session.events()))
    assert isinstance(event, UnknownEvent)
    assert event.type == "Diarization"
    session.close()


def test_keepalive_timer_fires_during_quiet(mock_server: ServerFactory, api_key_env: str) -> None:
    server = mock_server()
    client = BwSttClient(base_url=server.url)
    session = client.connect(keepalive_interval=0.05)
    wait_until(lambda: server.recorder.keepalives >= 2)
    session.close()


def test_keepalive_disabled(mock_server: ServerFactory, api_key_env: str) -> None:
    server = mock_server()
    client = BwSttClient(base_url=server.url)
    session = client.connect(keepalive_interval=None)
    time.sleep(0.15)
    assert server.recorder.keepalives == 0
    session.close()


def test_keepalive_zero_disables(mock_server: ServerFactory, api_key_env: str) -> None:
    server = mock_server()
    client = BwSttClient(base_url=server.url)
    session = client.connect(keepalive_interval=0)
    time.sleep(0.15)
    assert server.recorder.keepalives == 0
    session.close()


def test_keepalive_negative_rejected(mock_server: ServerFactory, api_key_env: str) -> None:
    server = mock_server()
    client = BwSttClient(base_url=server.url)
    with pytest.raises(ValueError, match="negative"):
        client.connect(keepalive_interval=-1)


def test_rate_limit_rejection(mock_server: ServerFactory, api_key_env: str) -> None:
    server = mock_server(Script(reject_status=429, reject_headers={"Retry-After": "1.5"}))
    client = BwSttClient(base_url=server.url)
    with pytest.raises(RateLimitError) as excinfo:
        client.connect()
    assert excinfo.value.retry_after == 1.5


def test_auth_rejection(mock_server: ServerFactory, api_key_env: str) -> None:
    server = mock_server(Script(reject_status=401))
    client = BwSttClient(base_url=server.url)
    with pytest.raises(AuthenticationError):
        client.connect()


def test_service_unavailable_rejection(mock_server: ServerFactory, api_key_env: str) -> None:
    server = mock_server(Script(reject_status=503))
    client = BwSttClient(base_url=server.url)
    with pytest.raises(ServiceUnavailableError):
        client.connect()


def test_context_manager_closes_gracefully(mock_server: ServerFactory, api_key_env: str) -> None:
    server = mock_server()
    client = BwSttClient(base_url=server.url)
    with client.connect() as session:
        session.send_audio(AUDIO_160MS)
    assert not session.is_open
    assert server.recorder.audio_bytes == 5120


def test_rate_limit_rejection_http_date(mock_server: ServerFactory, api_key_env: str) -> None:
    when = datetime.now(timezone.utc) + timedelta(seconds=60)
    header = format_datetime(when, usegmt=True)
    server = mock_server(Script(reject_status=429, reject_headers={"Retry-After": header}))
    client = BwSttClient(base_url=server.url)
    with pytest.raises(RateLimitError) as excinfo:
        client.connect()
    assert excinfo.value.retry_after is not None
    assert 50.0 <= excinfo.value.retry_after <= 60.0


def test_connect_timeout_without_session_opened(
    mock_server: ServerFactory, api_key_env: str
) -> None:
    server = mock_server(Script(defer_opened=True))
    client = BwSttClient(base_url=server.url)
    start = time.monotonic()
    with pytest.raises(ServiceUnavailableError, match=r"connect timed out after 0\.3s"):
        client.connect(connect_timeout=0.3)
    assert time.monotonic() - start < 3.0


def test_callback_may_call_session_methods(mock_server: ServerFactory, api_key_env: str) -> None:
    script = Script(after_open=[dict(DOC_SEGMENTS[0])], on_close=[])
    server = mock_server(script)
    client = BwSttClient(base_url=server.url)
    session = client.connect()
    seen: list[str] = []

    def callback(segment: Segment) -> None:
        session.finalize()
        seen.append(segment.text)

    session.on_segment(callback)
    event = next(session.events())
    assert isinstance(event, Segment)
    assert seen == ["i need"]
    wait_until(lambda: server.recorder.finalizes >= 1)
    session.close()


def test_quickstart_pattern_loses_no_segments(
    mock_server: ServerFactory, api_key_env: str, wav_file: Path
) -> None:
    # the README quickstart against a server that flushes all segments after CloseStream
    server = mock_server()
    client = BwSttClient(base_url=server.url)
    transcript = TranscriptAssembler()
    with client.connect(encoding="linear16", sample_rate=16000) as session:
        session.on_segment(transcript.push)
        for _segment in session.stream_file(wav_file):
            pass
        closed = session.close_stream()
    assert transcript.text == "i need a dry van"
    assert closed.audio_duration_seconds == pytest.approx(0.5)


def test_events_after_close_stream_replays_drained(
    mock_server: ServerFactory, api_key_env: str
) -> None:
    server = mock_server()
    client = BwSttClient(base_url=server.url)
    session = client.connect()
    seen: list[str] = []
    session.on_segment(lambda segment: seen.append(segment.text))
    session.send_audio(AUDIO_160MS)
    closed = session.close_stream()
    events = list(session.events())
    assert [type(e).__name__ for e in events] == ["Segment", "Segment", "Segment", "SessionClosed"]
    assert events[-1] is closed
    assert [e.text for e in events if isinstance(e, Segment)] == ["i need", " a dr", "y van"]
    assert seen == ["i need", " a dr", "y van"]  # dispatched once, during the drain
    assert list(session.events()) == []
