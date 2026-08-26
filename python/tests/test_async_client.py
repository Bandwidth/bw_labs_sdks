from __future__ import annotations

import asyncio
import json
import time
from collections.abc import AsyncIterator
from pathlib import Path
from urllib.parse import parse_qsl, urlsplit

import pytest

from bw_stt import (
    AsyncBwSttClient,
    AsyncSession,
    ConnectionClosedError,
    ErrorEvent,
    RateLimitError,
    Segment,
    ServiceUnavailableError,
    SessionClosed,
    TranscriptAssembler,
    UnknownEvent,
    WordAssembler,
)
from bw_stt._wire import SessionParams

from .conftest import HttpServerFactory, ServerFactory
from .mocks import DOC_SEGMENTS, Script

AUDIO_160MS = b"\0" * 5120

SESSION_OPENED_JSON = json.dumps(
    {
        "type": "SessionOpened",
        "request_id": "req-1",
        "model_info": {"name": "bw-streaming-en", "version": "current"},
        "channels": 1,
        "sample_rate": 16000,
        "encoding": "linear16",
    }
)


def test_connect_and_close_stream(mock_server: ServerFactory, api_key_env: str) -> None:
    server = mock_server()

    async def scenario() -> None:
        client = AsyncBwSttClient(base_url=server.url)
        transcript = TranscriptAssembler()
        session = await client.connect(mode="demand")
        assert session.opened.request_id == "req-1"
        session.on_segment(transcript.push)
        await session.send_audio(AUDIO_160MS)
        closed = await session.close_stream()
        assert closed.audio_duration_seconds == pytest.approx(0.16)
        assert transcript.text == "i need a dry van"

    asyncio.run(scenario())
    assert server.recorder.headers["x-bw-labs-api-key"] == api_key_env
    assert server.recorder.path is not None
    query = dict(parse_qsl(urlsplit(server.recorder.path).query))
    assert query["mode"] == "demand"


def test_async_events_and_unknown(mock_server: ServerFactory, api_key_env: str) -> None:
    closed_event = {
        "type": "SessionClosed",
        "request_id": "req-1",
        "audio_duration_seconds": 0.5,
        "session_duration_seconds": 1.0,
    }
    script = Script(after_open=[{"type": "Diarization", "x": 1}, closed_event])
    server = mock_server(script)

    async def scenario() -> None:
        client = AsyncBwSttClient(base_url=server.url)
        session = await client.connect()
        events = [event async for event in session.events()]
        assert isinstance(events[0], UnknownEvent)
        assert events[0].type == "Diarization"
        assert isinstance(events[1], SessionClosed)
        await session.close()

    asyncio.run(scenario())


def test_async_error_event_then_close(mock_server: ServerFactory, api_key_env: str) -> None:
    script = Script(
        after_open=[{"type": "Error", "code": "upstream_unavailable", "message": "down"}],
        close_after_open_events=True,
    )
    server = mock_server(script)

    async def scenario() -> None:
        client = AsyncBwSttClient(base_url=server.url)
        session = await client.connect()
        iterator = session.events()
        event = await iterator.__anext__()
        assert isinstance(event, ErrorEvent)
        with pytest.raises(ConnectionClosedError) as excinfo:
            await iterator.__anext__()
        assert excinfo.value.error_event is event

    asyncio.run(scenario())


def test_async_stream_chunks(mock_server: ServerFactory, api_key_env: str) -> None:
    script = Script(segments_per_frame={1: [dict(DOC_SEGMENTS[0])]})
    server = mock_server(script)

    async def scenario() -> None:
        client = AsyncBwSttClient(base_url=server.url)
        async with await client.connect() as session:

            async def chunks() -> AsyncIterator[bytes]:
                yield b"\0" * 5120  # frame 1; the server responds with a segment
                deadline = time.monotonic() + 5.0
                while session._queue.qsize() < 1 and time.monotonic() < deadline:
                    await asyncio.sleep(0.01)
                assert session._queue.qsize() >= 1  # segment delivered before the final poll
                yield b"\0" * 640

            segments = [segment async for segment in session.stream_chunks(chunks())]
            assert [s.text for s in segments] == ["i need"]

    asyncio.run(scenario())
    assert [len(f) for f in server.recorder.frames] == [5120, 640]


def test_async_stream_file(mock_server: ServerFactory, api_key_env: str, wav_file: Path) -> None:
    server = mock_server()

    async def scenario() -> None:
        client = AsyncBwSttClient(base_url=server.url)
        words = WordAssembler()
        session = await client.connect()
        session.on_segment(words.push)
        async for _segment in session.stream_file(wav_file):
            pass
        await session.close_stream()
        assert [w.text for w in words.words] == ["i", "need", "a", "dry", "van"]

    asyncio.run(scenario())
    assert [len(f) for f in server.recorder.frames] == [5120, 5120, 5120, 640]


def test_async_keepalive_timer(mock_server: ServerFactory, api_key_env: str) -> None:
    server = mock_server()

    async def scenario() -> None:
        client = AsyncBwSttClient(base_url=server.url)
        session = await client.connect(keepalive_interval=0.05)
        deadline = time.monotonic() + 2.0
        while server.recorder.keepalives < 2 and time.monotonic() < deadline:
            await asyncio.sleep(0.01)
        assert server.recorder.keepalives >= 2
        await session.close()

    asyncio.run(scenario())


def test_async_context_manager_closes(mock_server: ServerFactory, api_key_env: str) -> None:
    server = mock_server()

    async def scenario() -> None:
        client = AsyncBwSttClient(base_url=server.url)
        async with await client.connect() as session:
            await session.send_audio(AUDIO_160MS)
        assert not session.is_open

    asyncio.run(scenario())
    assert server.recorder.audio_bytes == 5120


def test_async_rate_limit_rejection(mock_server: ServerFactory, api_key_env: str) -> None:
    server = mock_server(Script(reject_status=429, reject_headers={"Retry-After": "2"}))

    async def scenario() -> None:
        client = AsyncBwSttClient(base_url=server.url)
        with pytest.raises(RateLimitError) as excinfo:
            await client.connect()
        assert excinfo.value.retry_after == 2.0

    asyncio.run(scenario())


def test_async_on_segment_awaitable_callback(mock_server: ServerFactory, api_key_env: str) -> None:
    server = mock_server()
    seen: list[str] = []

    async def scenario() -> None:
        client = AsyncBwSttClient(base_url=server.url)
        session = await client.connect()

        async def callback(segment: Segment) -> None:
            seen.append(segment.text)

        session.on_segment(callback)
        await session.send_audio(AUDIO_160MS)
        await session.close_stream()

    asyncio.run(scenario())
    assert seen == ["i need", " a dr", "y van"]


def test_async_events_after_close_stream_replays_drained(
    mock_server: ServerFactory, api_key_env: str
) -> None:
    server = mock_server()
    seen: list[str] = []

    async def scenario() -> None:
        client = AsyncBwSttClient(base_url=server.url)
        session = await client.connect()
        session.on_segment(lambda segment: seen.append(segment.text))
        await session.send_audio(AUDIO_160MS)
        closed = await session.close_stream()
        events = [event async for event in session.events()]
        assert [type(e).__name__ for e in events] == [
            "Segment",
            "Segment",
            "Segment",
            "SessionClosed",
        ]
        assert events[-1] is closed
        assert seen == ["i need", " a dr", "y van"]  # dispatched once, during the drain
        assert [event async for event in session.events()] == []

    asyncio.run(scenario())


class _FailingSendWs:
    """A stub connection whose handshake succeeds but whose sends fail."""

    def __init__(self) -> None:
        self._opened_sent = False
        self._closed = asyncio.Event()

    async def recv(self) -> str:
        if not self._opened_sent:
            self._opened_sent = True
            return SESSION_OPENED_JSON
        await self._closed.wait()
        raise ConnectionError("connection is closed")

    async def send(self, payload: str | bytes) -> None:
        raise ConnectionError("send failed")

    async def close(self) -> None:
        self._closed.set()


def test_close_stream_send_failure_still_closes() -> None:
    async def scenario() -> None:
        session = AsyncSession(_FailingSendWs(), SessionParams(), None)
        await session._handshake()
        with pytest.raises(ConnectionClosedError, match="closed while sending"):
            await session.close_stream()
        assert not session.is_open
        assert session._closed
        with pytest.raises(ConnectionClosedError):
            await session.close_stream()

    asyncio.run(scenario())


def test_async_connect_timeout(mock_server: ServerFactory, api_key_env: str) -> None:
    server = mock_server(Script(defer_opened=True))

    async def scenario() -> None:
        client = AsyncBwSttClient(base_url=server.url)
        start = time.monotonic()
        with pytest.raises(ServiceUnavailableError, match=r"connect timed out after 0\.3s"):
            await client.connect(connect_timeout=0.3)
        assert time.monotonic() - start < 3.0

    asyncio.run(scenario())


def test_async_transcribe(mock_http_server: HttpServerFactory, api_key_env: str) -> None:
    server = mock_http_server()

    async def scenario() -> None:
        client = AsyncBwSttClient(base_url=server.base_url)
        result = await client.transcribe(b"\0" * 32000, keywords=["dry van"])
        assert result.text == "i need a dry van"
        assert result.audio_duration_seconds == 2.5

    asyncio.run(scenario())
    assert server.recorder.body == b"\0" * 32000
    assert server.recorder.path is not None
    query = parse_qsl(urlsplit(server.recorder.path).query)
    assert ("keywords", "dry van") in query
