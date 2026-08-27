from __future__ import annotations

import contextlib
import socket
import threading
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
    InvalidRequestError,
    ProtocolError,
    RateLimitError,
    ServiceUnavailableError,
    Transcription,
)
from bw_stt._http import parse_retry_after

from .conftest import HttpServerFactory, write_wav
from .mocks import HttpScript


@contextlib.contextmanager
def stalled_http_server(send_partial_body: bool) -> Iterator[str]:
    """A server that accepts a request and then never finishes the response."""
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    listener.bind(("127.0.0.1", 0))
    listener.listen(1)
    port = listener.getsockname()[1]
    release = threading.Event()

    def serve() -> None:
        try:
            conn, _ = listener.accept()
        except OSError:
            return
        with conn, contextlib.suppress(OSError):
            conn.settimeout(5.0)
            conn.recv(65536)
            if send_partial_body:
                conn.sendall(
                    b"HTTP/1.1 200 OK\r\n"
                    b"Content-Type: application/json\r\n"
                    b"Content-Length: 1000\r\n\r\n{"
                )
            release.wait(10.0)

    thread = threading.Thread(target=serve, name="stalled-http", daemon=True)
    thread.start()
    try:
        yield f"ws://127.0.0.1:{port}/audio/v1/listen"
    finally:
        release.set()
        listener.close()
        thread.join(timeout=5.0)


def test_transcribe_bytes_params_and_response(
    mock_http_server: HttpServerFactory, api_key_env: str
) -> None:
    server = mock_http_server()
    client = BwSttClient(base_url=server.base_url)
    result = client.transcribe(
        b"\0" * 32000,
        model="tag-1",
        redact_pii=True,
        redact_pii_sub="entity_name",
        keywords=["dry van", "reefer"],
    )
    assert isinstance(result, Transcription)
    assert result.request_id == "req-t"
    assert result.text == "i need a dry van"
    assert [w.word for w in result.words][:2] == ["i", "need"]
    assert result.segments[0].text == "i need a dry van"
    assert result.segments[0].start == 0.0
    assert result.segments[0].end == 0.72
    assert result.audio_duration_seconds == 2.5
    assert result.raw["request_id"] == "req-t"

    recorder = server.recorder
    assert recorder.method == "POST"
    assert recorder.body == b"\0" * 32000
    assert recorder.headers["x-bw-labs-api-key"] == api_key_env
    assert recorder.headers["content-type"] == "application/octet-stream"
    assert recorder.path is not None
    assert urlsplit(recorder.path).path == "/audio/v1/transcribe"
    query = parse_qsl(urlsplit(recorder.path).query)
    as_dict = dict(query)
    assert as_dict["encoding"] == "linear16"
    assert as_dict["sample_rate"] == "16000"
    assert as_dict["channels"] == "1"
    assert as_dict["model"] == "tag-1"
    assert as_dict["redact_pii"] == "true"
    assert as_dict["redact_pii_sub"] == "entity_name"
    assert [value for name, value in query if name == "keywords"] == ["dry van", "reefer"]
    assert "mode" not in as_dict
    assert "multichannel" not in as_dict


def test_transcribe_redacted_entity_return_params(
    mock_http_server: HttpServerFactory, api_key_env: str
) -> None:
    server = mock_http_server()
    client = BwSttClient(base_url=server.base_url)
    client.transcribe(b"\0" * 32000, redact_pii=True, redact_pii_return=True)
    query = dict(parse_qsl(urlsplit(server.recorder.path or "").query))
    assert query["redact_pii"] == "true"
    assert query["redact_pii_return"] == "true"
    assert "redact_pii_sub" not in query


def test_transcribe_wav_path_uses_header_rate(
    mock_http_server: HttpServerFactory, api_key_env: str, tmp_path: Path
) -> None:
    path = tmp_path / "call.wav"
    payload = write_wav(path, seconds=0.5, sample_rate=8000, channels=2)
    server = mock_http_server()
    client = BwSttClient(base_url=server.base_url)
    client.transcribe(path)
    query = dict(parse_qsl(urlsplit(server.recorder.path or "").query))
    assert "encoding" not in query
    assert "sample_rate" not in query
    assert query["channels"] == "2"
    assert server.recorder.headers["content-type"] == "audio/wav"
    assert server.recorder.body == path.read_bytes()
    assert payload == server.recorder.body[-len(payload) :]


def test_transcribe_wav_path_rejects_non_pcm16(
    mock_http_server: HttpServerFactory, api_key_env: str, tmp_path: Path
) -> None:
    path = tmp_path / "bad.wav"
    path.write_bytes(b"RIFFxxxxWAVE")
    server = mock_http_server()
    client = BwSttClient(base_url=server.base_url)
    with pytest.raises(ValueError, match="WAV"):
        client.transcribe(path)


def test_transcribe_wav_path_rejects_other_encoding(
    mock_http_server: HttpServerFactory, api_key_env: str, tmp_path: Path
) -> None:
    path = tmp_path / "call.wav"
    write_wav(path, seconds=0.5)
    server = mock_http_server()
    client = BwSttClient(base_url=server.base_url)
    with pytest.raises(ValueError, match="raw=True"):
        client.transcribe(path, encoding="mulaw", sample_rate=8000)


def test_transcribe_raw_path(
    mock_http_server: HttpServerFactory, api_key_env: str, tmp_path: Path
) -> None:
    path = tmp_path / "call.pcm"
    path.write_bytes(b"\0" * 8000)
    server = mock_http_server()
    client = BwSttClient(base_url=server.base_url)
    client.transcribe(path, encoding="linear16", sample_rate=8000, raw=True)
    query = dict(parse_qsl(urlsplit(server.recorder.path or "").query))
    assert query["encoding"] == "linear16"
    assert query["sample_rate"] == "8000"
    assert server.recorder.headers["content-type"] == "application/octet-stream"
    assert server.recorder.body == b"\0" * 8000


def test_transcribe_rejects_non_linear16_raw_audio(
    mock_http_server: HttpServerFactory, api_key_env: str
) -> None:
    server = mock_http_server()
    client = BwSttClient(base_url=server.base_url)
    with pytest.raises(ValueError, match="linear16"):
        client.transcribe(b"\0" * 3200, encoding="mulaw")  # type: ignore[arg-type]


def test_transcribe_error_mappings(mock_http_server: HttpServerFactory, api_key_env: str) -> None:
    cases: list[tuple[HttpScript, type[Exception], str]] = [
        (
            HttpScript(status=400, body={"code": "invalid_params", "message": "bad encoding"}),
            InvalidRequestError,
            "bad encoding",
        ),
        (HttpScript(status=401), AuthenticationError, "401"),
        (HttpScript(status=403), AuthenticationError, "403"),
        (HttpScript(status=413), InvalidRequestError, "five minutes"),
        (HttpScript(status=500), ServiceUnavailableError, "500"),
        (HttpScript(status=503), ServiceUnavailableError, "503"),
    ]
    for script, expected, needle in cases:
        server = mock_http_server(script)
        client = BwSttClient(base_url=server.base_url)
        with pytest.raises(expected, match=needle):
            client.transcribe(b"\0" * 3200)


def test_transcribe_rate_limit_retry_after(
    mock_http_server: HttpServerFactory, api_key_env: str
) -> None:
    server = mock_http_server(HttpScript(status=429, headers={"Retry-After": "3.5"}))
    client = BwSttClient(base_url=server.base_url)
    with pytest.raises(RateLimitError) as excinfo:
        client.transcribe(b"\0" * 3200)
    assert excinfo.value.retry_after == 3.5


def test_transcribe_rate_limit_retry_after_http_date(
    mock_http_server: HttpServerFactory, api_key_env: str
) -> None:
    when = datetime.now(timezone.utc) + timedelta(seconds=60)
    header = format_datetime(when, usegmt=True)
    server = mock_http_server(HttpScript(status=429, headers={"Retry-After": header}))
    client = BwSttClient(base_url=server.base_url)
    with pytest.raises(RateLimitError) as excinfo:
        client.transcribe(b"\0" * 3200)
    assert excinfo.value.retry_after is not None
    assert 50.0 <= excinfo.value.retry_after <= 60.0


def test_parse_retry_after_forms() -> None:
    assert parse_retry_after(None) is None
    assert parse_retry_after("2.5") == 2.5
    assert parse_retry_after("not a date") is None
    past = datetime.now(timezone.utc) - timedelta(seconds=60)
    assert parse_retry_after(format_datetime(past, usegmt=True)) == 0.0


def test_transcribe_timeout_on_stalled_headers(api_key_env: str) -> None:
    with stalled_http_server(send_partial_body=False) as base_url:
        client = BwSttClient(base_url=base_url)
        start = time.monotonic()
        with pytest.raises(ServiceUnavailableError, match=r"timed out after 0\.5s"):
            client.transcribe(b"\0" * 3200, timeout=0.5)
        assert time.monotonic() - start < 3.0


def test_transcribe_timeout_on_stalled_body(api_key_env: str) -> None:
    with stalled_http_server(send_partial_body=True) as base_url:
        client = BwSttClient(base_url=base_url)
        start = time.monotonic()
        with pytest.raises(ServiceUnavailableError, match=r"timed out after 0\.5s"):
            client.transcribe(b"\0" * 3200, timeout=0.5)
        assert time.monotonic() - start < 3.0


def test_transcribe_malformed_response(
    mock_http_server: HttpServerFactory, api_key_env: str
) -> None:
    server = mock_http_server(HttpScript(raw_body=b"<html>oops</html>"))
    client = BwSttClient(base_url=server.base_url)
    with pytest.raises(ProtocolError):
        client.transcribe(b"\0" * 3200)


def test_transcribe_rejects_empty_audio(
    mock_http_server: HttpServerFactory, api_key_env: str
) -> None:
    server = mock_http_server()
    client = BwSttClient(base_url=server.base_url)
    with pytest.raises(ValueError, match="no audio"):
        client.transcribe(b"")
