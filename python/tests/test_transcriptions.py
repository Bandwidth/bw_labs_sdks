from __future__ import annotations

import asyncio
import io
import json
from pathlib import Path
from urllib.parse import parse_qsl, urlsplit

import pytest

from bw_stt import (
    AsyncBwSttClient,
    BwSttClient,
    JobLimitError,
    JobPlatformUnavailableError,
    TranscriptionJobError,
    TranscriptionNotFoundError,
    TranscriptionTimeoutError,
)

from .conftest import JobServerFactory, write_wav
from .mocks import DEFAULT_TRANSCRIPTION, HttpScript


def _submission() -> dict[str, object]:
    return {"id": "job-1", "status": "queued"}


def _status(
    status: str,
    *,
    result: dict[str, object] | None = None,
    error: dict[str, str] | None = None,
) -> dict[str, object]:
    return {
        "id": "job-1",
        "status": status,
        "progress": 1.0 if status in ("completed", "error") else 0.25,
        "created_at": "2026-09-03T12:00:00Z",
        "updated_at": "2026-09-03T12:00:01Z",
        "result": result,
        "error": error,
    }


def test_submit_upload_sends_callback_credentials_as_headers(
    mock_transcriptions_server: JobServerFactory, api_key_env: str
) -> None:
    server = mock_transcriptions_server([HttpScript(status=202, body=_submission())])
    client = BwSttClient(base_url=server.base_url)
    result = client.transcriptions.submit(
        b"\0" * 3200,
        channels=2,
        multichannel=True,
        model="tag-1",
        callback_url="https://hooks.example.test/stt",
        callback_auth_header_name="X-Callback-Key",
        callback_auth_header_value="callback-secret",
    )

    assert result.id == "job-1"
    request = server.requests[0]
    assert request.method == "POST"
    assert urlsplit(request.path or "").path == "/audio/v1/transcriptions"
    assert request.body == b"\0" * 3200
    assert request.headers["content-type"] == "application/octet-stream"
    assert request.headers["x-bw-labs-api-key"] == api_key_env
    query = parse_qsl(urlsplit(request.path or "").query)
    assert dict(query)["multichannel"] == "true"
    assert dict(query)["channels"] == "2"
    assert dict(query)["callback_url"] == "https://hooks.example.test/stt"
    assert "callback_auth_header_name" not in dict(query)
    assert "callback_auth_header_value" not in dict(query)
    assert request.headers["x-callback-auth-name"] == "X-Callback-Key"
    assert request.headers["x-callback-auth-value"] == "callback-secret"


def test_submit_url_sends_json_and_options(
    mock_transcriptions_server: JobServerFactory, api_key_env: str
) -> None:
    server = mock_transcriptions_server([HttpScript(status=202, body=_submission())])
    client = BwSttClient(base_url=server.base_url)
    result = client.transcriptions.submit_url(
        "https://media.example.test/call.wav",
        sample_rate=8000,
        channels=2,
        multichannel=True,
        callback_url="https://hooks.example.test/stt",
        callback_auth_header_name="X-Callback-Key",
        callback_auth_header_value="callback-secret",
    )

    assert result.status == "queued"
    request = server.requests[0]
    assert request.headers["content-type"] == "application/json"
    assert json.loads(request.body) == {
        "audio_url": "https://media.example.test/call.wav",
        "callback": {
            "url": "https://hooks.example.test/stt",
            "auth_header_name": "X-Callback-Key",
            "auth_header_value": "callback-secret",
        },
    }
    query = dict(parse_qsl(urlsplit(request.path or "").query))
    assert query["channels"] == "2"
    assert query["multichannel"] == "true"
    assert query["sample_rate"] == "8000"
    assert "callback_url" not in query
    assert "callback_auth_header_name" not in query
    assert "callback_auth_header_value" not in query
    assert "x-callback-auth-name" not in request.headers
    assert "x-callback-auth-value" not in request.headers
    assert request.headers["x-bw-labs-api-key"] == api_key_env


def test_submit_url_allows_server_to_infer_multichannel_audio(
    mock_transcriptions_server: JobServerFactory, api_key_env: str
) -> None:
    server = mock_transcriptions_server([HttpScript(status=202, body=_submission())])
    BwSttClient(base_url=server.base_url).transcriptions.submit_url(
        "https://media.example.test/call.wav", multichannel=True
    )
    query = dict(parse_qsl(urlsplit(server.requests[0].path or "").query))
    assert query["multichannel"] == "true"
    assert "channels" not in query


def test_submit_path_uploads_wav_container(
    mock_transcriptions_server: JobServerFactory, api_key_env: str, tmp_path: Path
) -> None:
    path = tmp_path / "stereo.wav"
    write_wav(path, seconds=0.1, sample_rate=8000, channels=2)
    server = mock_transcriptions_server([HttpScript(status=202, body=_submission())])
    BwSttClient(base_url=server.base_url).transcriptions.submit(path, multichannel=True, channels=2)
    request = server.requests[0]
    assert request.headers["content-type"] == "audio/wav"
    assert request.body == path.read_bytes()
    query = dict(parse_qsl(urlsplit(request.path or "").query))
    assert "encoding" not in query
    assert "sample_rate" not in query
    assert query["channels"] == "2"


def test_submit_binary_wav_file_object(
    mock_transcriptions_server: JobServerFactory, api_key_env: str, tmp_path: Path
) -> None:
    path = tmp_path / "file-object.wav"
    write_wav(path, seconds=0.1, sample_rate=8000, channels=2)
    server = mock_transcriptions_server([HttpScript(status=202, body=_submission())])
    with io.BytesIO(path.read_bytes()) as audio:
        BwSttClient(base_url=server.base_url).transcriptions.submit(audio)
    request = server.requests[0]
    assert request.headers["content-type"] == "audio/wav"
    assert request.body == path.read_bytes()


def test_submit_wav_bytes_sniffs_container(
    mock_transcriptions_server: JobServerFactory, api_key_env: str, tmp_path: Path
) -> None:
    path = tmp_path / "bytes.wav"
    write_wav(path, seconds=0.1, sample_rate=8000, channels=2)
    wav_bytes = path.read_bytes()
    server = mock_transcriptions_server([HttpScript(status=202, body=_submission())])
    BwSttClient(base_url=server.base_url).transcriptions.submit(wav_bytes, raw=False)
    request = server.requests[0]
    assert request.headers["content-type"] == "audio/wav"
    assert request.body == wav_bytes
    query = dict(parse_qsl(urlsplit(request.path or "").query))
    assert "encoding" not in query
    assert "sample_rate" not in query
    assert query["channels"] == "2"


def test_submit_path_raw_true_sends_bytes_as_raw(
    mock_transcriptions_server: JobServerFactory, api_key_env: str, tmp_path: Path
) -> None:
    path = tmp_path / "raw.wav"
    write_wav(path, seconds=0.1, sample_rate=8000)
    server = mock_transcriptions_server([HttpScript(status=202, body=_submission())])
    BwSttClient(base_url=server.base_url).transcriptions.submit(path, raw=True, sample_rate=8000)
    request = server.requests[0]
    assert request.headers["content-type"] == "application/octet-stream"
    assert request.body == path.read_bytes()
    query = dict(parse_qsl(urlsplit(request.path or "").query))
    assert query["encoding"] == "linear16"
    assert query["sample_rate"] == "8000"


def test_transcribe_multichannel_query_and_typed_channels(
    mock_http_server, api_key_env: str
) -> None:
    result = {
        "request_id": DEFAULT_TRANSCRIPTION["request_id"],
        "audio_duration_seconds": DEFAULT_TRANSCRIPTION["audio_duration_seconds"],
        "model_info": DEFAULT_TRANSCRIPTION["model_info"],
        "channels": [
            {"channel": 0, "text": "left", "words": [], "segments": []},
            {"channel": 1, "text": "right", "words": [], "segments": []},
        ],
    }
    server = mock_http_server(HttpScript(body=result))
    transcription = BwSttClient(base_url=server.base_url).transcribe(
        b"\0" * 3200, channels=2, multichannel=True
    )
    assert transcription.channels is not None
    assert [channel.text for channel in transcription.channels] == ["left", "right"]
    query = dict(parse_qsl(urlsplit(server.recorder.path or "").query))
    assert query["multichannel"] == "true"


def test_get_lifecycle_and_delete(
    mock_transcriptions_server: JobServerFactory, api_key_env: str
) -> None:
    scripts = [
        HttpScript(status=200, body=_status("processing")),
        HttpScript(status=204),
    ]
    server = mock_transcriptions_server(scripts)
    client = BwSttClient(base_url=server.base_url)
    job = client.transcriptions.get("job-1")
    client.transcriptions.delete("job-1")
    assert job.status == "processing"
    assert job.progress == 0.25
    assert job.created_at.isoformat() == "2026-09-03T12:00:00+00:00"
    assert [request.method for request in server.requests] == ["GET", "DELETE"]


def test_wait_success_and_multichannel_parse(
    mock_transcriptions_server: JobServerFactory, api_key_env: str
) -> None:
    result = {
        "request_id": DEFAULT_TRANSCRIPTION["request_id"],
        "audio_duration_seconds": DEFAULT_TRANSCRIPTION["audio_duration_seconds"],
        "model_info": DEFAULT_TRANSCRIPTION["model_info"],
        "channels": [
            {
                "channel": 0,
                "text": "left",
                "words": [{"word": "left", "start": 0.0, "end": 0.2}],
                "segments": [{"start": 0.0, "end": 0.2, "text": "left"}],
            },
            {
                "channel": 1,
                "text": "right",
                "words": [{"word": "right", "start": 0.0, "end": 0.2}],
                "segments": [{"start": 0.0, "end": 0.2, "text": "right"}],
            },
        ],
    }
    server = mock_transcriptions_server(
        [
            HttpScript(status=200, body=_status("queued")),
            HttpScript(status=200, body=_status("completed", result=result)),
        ]
    )
    transcription = BwSttClient(base_url=server.base_url).transcriptions.wait(
        "job-1", poll_interval=0, timeout=1
    )
    assert transcription.channels is not None
    assert [channel.text for channel in transcription.channels] == ["left", "right"]
    assert [request.method for request in server.requests] == ["GET", "GET"]


def test_wait_timeout_uses_typed_error(
    mock_transcriptions_server: JobServerFactory, api_key_env: str
) -> None:
    server = mock_transcriptions_server([HttpScript(status=200, body=_status("queued"))])
    with pytest.raises(TranscriptionTimeoutError) as excinfo:
        BwSttClient(base_url=server.base_url).transcriptions.wait(
            "job-1", poll_interval=2, timeout=0.01
        )
    assert isinstance(excinfo.value, TimeoutError)


def test_wait_error_includes_code_without_api_key(
    mock_transcriptions_server: JobServerFactory, api_key_env: str
) -> None:
    server = mock_transcriptions_server(
        [
            HttpScript(
                status=200,
                body=_status(
                    "error",
                    error={"code": "audio_unavailable", "message": f"failed for {api_key_env}"},
                ),
            ),
        ]
    )
    with pytest.raises(TranscriptionJobError) as excinfo:
        BwSttClient(base_url=server.base_url).transcriptions.wait("job-1", timeout=1)
    assert excinfo.value.code == "audio_unavailable"
    assert api_key_env not in str(excinfo.value)


@pytest.mark.parametrize(
    ("status", "expected"),
    [(429, JobLimitError), (503, JobPlatformUnavailableError), (404, TranscriptionNotFoundError)],
)
def test_job_http_error_mapping(
    mock_transcriptions_server: JobServerFactory,
    api_key_env: str,
    status: int,
    expected: type[Exception],
) -> None:
    server = mock_transcriptions_server(
        [HttpScript(status=status, body={"code": "job_limit_reached", "message": api_key_env})]
    )
    with pytest.raises(expected) as excinfo:
        BwSttClient(base_url=server.base_url).transcriptions.get("foreign")
    assert api_key_env not in str(excinfo.value)


def test_job_submission_busy_maps_to_job_limit_error_with_retry_after(
    mock_transcriptions_server: JobServerFactory, api_key_env: str
) -> None:
    server = mock_transcriptions_server(
        [
            HttpScript(
                status=429,
                headers={"Retry-After": "5"},
                body={"code": "job_submission_busy", "message": api_key_env},
            )
        ]
    )
    with pytest.raises(JobLimitError) as excinfo:
        BwSttClient(base_url=server.base_url).transcriptions.submit(b"\0" * 3200)
    assert excinfo.value.code == "job_submission_busy"
    assert excinfo.value.retry_after == pytest.approx(5.0)
    assert api_key_env not in str(excinfo.value)


def test_multichannel_validation_happens_before_upload(
    mock_transcriptions_server: JobServerFactory, api_key_env: str
) -> None:
    server = mock_transcriptions_server([])
    client = BwSttClient(base_url=server.base_url)
    with pytest.raises(ValueError, match="channels=2"):
        client.transcribe(b"\0" * 3200, multichannel=True)
    with pytest.raises(ValueError, match="channels=2"):
        client.transcriptions.submit(b"\0" * 3200, multichannel=True)
    with pytest.raises(ValueError, match="channels=2"):
        client.transcriptions.submit_url(
            "https://media.example.test/audio.wav", channels=1, multichannel=True
        )
    assert server.requests == []


def test_async_transcriptions_wait(
    mock_transcriptions_server: JobServerFactory, api_key_env: str
) -> None:
    server = mock_transcriptions_server(
        [
            HttpScript(status=202, body=_submission()),
            HttpScript(status=200, body=_status("completed", result=DEFAULT_TRANSCRIPTION)),
        ]
    )

    async def run() -> str:
        client = AsyncBwSttClient(base_url=server.base_url)
        await client.transcriptions.submit(b"\0" * 3200)
        result = await client.transcriptions.wait("job-1", poll_interval=0, timeout=1)
        return result.text

    assert asyncio.run(run()) == "i need a dry van"


def test_async_transcriptions_wait_timeout_uses_typed_error(
    mock_transcriptions_server: JobServerFactory, api_key_env: str
) -> None:
    server = mock_transcriptions_server([HttpScript(status=200, body=_status("queued"))])

    async def run() -> None:
        with pytest.raises(TranscriptionTimeoutError) as excinfo:
            await AsyncBwSttClient(base_url=server.base_url).transcriptions.wait(
                "job-1", poll_interval=2, timeout=0.01
            )
        assert isinstance(excinfo.value, TimeoutError)

    asyncio.run(run())
