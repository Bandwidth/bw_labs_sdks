from __future__ import annotations

import wave
from collections.abc import Callable, Iterator
from pathlib import Path

import pytest

from .mocks import HttpScript, MockSttServer, MockTranscribeServer, Script

ServerFactory = Callable[..., MockSttServer]
HttpServerFactory = Callable[..., MockTranscribeServer]


@pytest.fixture
def mock_server() -> Iterator[ServerFactory]:
    servers: list[MockSttServer] = []

    def factory(script: Script | None = None) -> MockSttServer:
        server = MockSttServer(script)
        server.start()
        servers.append(server)
        return server

    yield factory
    for server in servers:
        server.stop()


@pytest.fixture
def mock_http_server() -> Iterator[HttpServerFactory]:
    servers: list[MockTranscribeServer] = []

    def factory(script: HttpScript | None = None) -> MockTranscribeServer:
        server = MockTranscribeServer(script)
        servers.append(server)
        return server

    yield factory
    for server in servers:
        server.stop()


@pytest.fixture
def api_key_env(monkeypatch: pytest.MonkeyPatch) -> str:
    key = "bwa_key_test"
    monkeypatch.setenv("BW_STT_API_KEY", key)
    return key


def write_wav(path: Path, seconds: float, sample_rate: int = 16000, channels: int = 1) -> bytes:
    frames = int(sample_rate * seconds)
    payload = bytes(2 * channels) * frames
    with wave.open(str(path), "wb") as writer:
        writer.setnchannels(channels)
        writer.setsampwidth(2)
        writer.setframerate(sample_rate)
        writer.writeframes(payload)
    return payload


@pytest.fixture
def wav_file(tmp_path: Path) -> Path:
    path = tmp_path / "audio.wav"
    write_wav(path, seconds=0.5)
    return path
