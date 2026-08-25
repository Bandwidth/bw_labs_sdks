from __future__ import annotations

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

from .conftest import HttpServerFactory, write_wav
from .mocks import HttpScript


def test_transcribe_bytes_params_and_response(
    mock_http_server: HttpServerFactory, api_key_env: str
) -> None:
    server = mock_http_server()
    client = BwSttClient(base_url=server.base_url)
    result = client.transcribe(
        b"\0" * 32000,
        model="tag-1",
        multichannel=False,
        redact_pii=True,
        redact_pii_policies=["ssn", "phone"],
        redact_pii_sub="entity_name",
        keywords=["dry van", "reefer"],
    )
    assert isinstance(result, Transcription)
    assert result.request_id == "req-t"
    assert result.text == "i need a dry van"
    assert [w.word for w in result.words][:2] == ["i", "need"]
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
    assert as_dict["redact_pii_policies"] == "ssn,phone"
    assert as_dict["redact_pii_sub"] == "entity_name"
    assert [value for name, value in query if name == "keywords"] == ["dry van", "reefer"]
    assert "mode" not in as_dict
    assert "multichannel" not in as_dict


def test_transcribe_wav_path_uses_header_rate(
    mock_http_server: HttpServerFactory, api_key_env: str, tmp_path: Path
) -> None:
    path = tmp_path / "call.wav"
    payload = write_wav(path, seconds=0.5, sample_rate=8000, channels=2)
    server = mock_http_server()
    client = BwSttClient(base_url=server.base_url)
    client.transcribe(path)
    query = dict(parse_qsl(urlsplit(server.recorder.path or "").query))
    assert query["encoding"] == "linear16"
    assert query["sample_rate"] == "8000"
    assert query["channels"] == "2"
    assert server.recorder.body == payload  # PCM payload only, no WAV header


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
    path = tmp_path / "call.ulaw"
    path.write_bytes(b"\x7f" * 8000)
    server = mock_http_server()
    client = BwSttClient(base_url=server.base_url)
    client.transcribe(path, encoding="mulaw", sample_rate=8000, raw=True)
    query = dict(parse_qsl(urlsplit(server.recorder.path or "").query))
    assert query["encoding"] == "mulaw"
    assert query["sample_rate"] == "8000"
    assert server.recorder.body == b"\x7f" * 8000


def test_transcribe_error_mappings(mock_http_server: HttpServerFactory, api_key_env: str) -> None:
    cases: list[tuple[HttpScript, type[Exception], str]] = [
        (
            HttpScript(status=400, body={"code": "invalid_params", "message": "bad encoding"}),
            InvalidRequestError,
            "bad encoding",
        ),
        (HttpScript(status=401), AuthenticationError, "401"),
        (HttpScript(status=403), AuthenticationError, "403"),
        (HttpScript(status=413), InvalidRequestError, "5 minutes"),
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
