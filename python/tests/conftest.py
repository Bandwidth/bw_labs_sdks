from __future__ import annotations

import struct
import time
import wave
from collections.abc import Callable, Iterator
from pathlib import Path

import pytest

from .mocks import HttpScript, MockSttServer, MockTranscribeServer, Script

ServerFactory = Callable[..., MockSttServer]
HttpServerFactory = Callable[..., MockTranscribeServer]


def wait_until(condition: Callable[[], bool], timeout: float = 5.0) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if condition():
            return
        time.sleep(0.01)
    raise AssertionError("condition not met in time")


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


def write_extensible_wav(
    path: Path,
    seconds: float,
    sample_rate: int = 16000,
    channels: int = 1,
    subformat: int = 1,
    bits: int = 16,
) -> bytes:
    """Write a WAVE_FORMAT_EXTENSIBLE file; subformat 1 is PCM, 3 is IEEE float."""
    frames = int(sample_rate * seconds)
    block_align = channels * bits // 8
    payload = bytes(block_align) * frames
    # KSDATAFORMAT_SUBTYPE GUID: the format code, then xxxx0000-0000-0010-8000-00AA00389B71
    guid = struct.pack("<HHHH", subformat, 0, 0, 0x0010) + bytes.fromhex("800000aa00389b71")
    fmt = (
        struct.pack(
            "<HHIIHHHHI",
            0xFFFE,
            channels,
            sample_rate,
            sample_rate * block_align,
            block_align,
            bits,
            22,
            bits,
            0,
        )
        + guid
    )
    body = (
        b"WAVE"
        + b"fmt "
        + struct.pack("<I", len(fmt))
        + fmt
        + b"data"
        + struct.pack("<I", len(payload))
        + payload
    )
    path.write_bytes(b"RIFF" + struct.pack("<I", len(body)) + body)
    return payload


@pytest.fixture
def wav_file(tmp_path: Path) -> Path:
    path = tmp_path / "audio.wav"
    write_wav(path, seconds=0.5)
    return path
