"""Synchronous and asynchronous clients for transcription jobs."""

from __future__ import annotations

import asyncio
import io
import json
import math
import time
import wave
from collections.abc import Callable, Sequence
from pathlib import Path
from typing import BinaryIO, Literal
from urllib.parse import quote, urlsplit, urlunsplit

from . import _http
from ._framing import read_wav_file
from ._wire import (
    TRANSCRIBE_RAW_CONTENT_TYPE,
    TRANSCRIBE_WAV_CONTENT_TYPE,
    SessionParams,
    append_callback_query,
    build_transcriptions_url,
)
from .errors import (
    ProtocolError,
    TranscriptionJobError,
)
from .events import Transcription
from .jobs import TranscriptionJob, TranscriptionJobSubmission

__all__ = [
    "AsyncTranscriptionsClient",
    "AudioInput",
    "TranscriptionsClient",
]

AudioInput = bytes | str | Path | BinaryIO
_DEFAULT_JOB_TIMEOUT = 120.0
_DEFAULT_WAIT_TIMEOUT = 300.0


def _check_timeout(timeout: float, name: str = "timeout") -> None:
    if not math.isfinite(timeout) or timeout <= 0:
        raise ValueError(f"{name} must be positive")


def _read_file_audio(audio: BinaryIO) -> bytes:
    data = audio.read()
    if not isinstance(data, bytes):
        raise TypeError("audio file must be opened in binary mode")
    return data


def _wav_info(data: bytes, label: str) -> tuple[int, int]:
    try:
        with wave.open(io.BytesIO(data), "rb") as reader:
            if reader.getcomptype() != "NONE":
                raise ValueError(f"{label}: WAV audio must be uncompressed PCM")
            if reader.getsampwidth() != 2:
                raise ValueError(f"{label}: WAV audio must be 16-bit PCM")
            return reader.getframerate(), reader.getnchannels()
    except (EOFError, OSError, wave.Error) as exc:
        raise ValueError(f"{label} is not a readable WAV file") from exc


def _callback_query(
    query: list[tuple[str, str]],
    *,
    callback_url: str | None,
    callback_auth_header_name: str | None,
    callback_auth_header_value: str | None,
) -> None:
    append_callback_query(
        query,
        callback_url=callback_url,
        callback_auth_header_name=callback_auth_header_name,
        callback_auth_header_value=callback_auth_header_value,
    )


def _prepare_upload(
    audio: AudioInput,
    *,
    encoding: Literal["linear16"],
    sample_rate: int,
    channels: int,
    multichannel: bool,
    model: str | None,
    redact_pii: bool,
    redact_pii_sub: str | None,
    redact_pii_return: bool,
    keywords: Sequence[str] | None,
    raw: bool,
    callback_url: str | None,
    callback_auth_header_name: str | None,
    callback_auth_header_value: str | None,
) -> tuple[bytes, str, list[tuple[str, str]]]:
    raw_input = True
    if isinstance(audio, (str, Path)):
        data = Path(audio).read_bytes()
        if not raw:
            if encoding != "linear16":
                raise ValueError(
                    "WAV input requires encoding='linear16'; pass raw=True to send "
                    "headerless linear16 audio bytes"
                )
            _, wav_sample_rate, wav_channels = read_wav_file(audio)
            if sample_rate != 16000 and sample_rate != wav_sample_rate:
                raise ValueError(
                    f"WAV input is {wav_sample_rate} Hz, the request specifies {sample_rate} Hz"
                )
            if channels != 1 and channels != wav_channels:
                raise ValueError(
                    f"WAV input has {wav_channels} channel(s), the request specifies {channels}"
                )
            sample_rate, channels = wav_sample_rate, wav_channels
            raw_input = False
    elif isinstance(audio, bytes):
        data = audio
        if encoding != "linear16":
            raise ValueError("raw transcription uploads require encoding='linear16'")
    else:
        data = _read_file_audio(audio)
        if not raw and data.startswith(b"RIFF") and len(data) >= 12 and data[8:12] == b"WAVE":
            if encoding != "linear16":
                raise ValueError(
                    "WAV input requires encoding='linear16'; pass raw=True to send "
                    "headerless linear16 audio bytes"
                )
            wav_sample_rate, wav_channels = _wav_info(data, "audio file")
            if sample_rate != 16000 and sample_rate != wav_sample_rate:
                raise ValueError(
                    f"WAV input is {wav_sample_rate} Hz, the request specifies {sample_rate} Hz"
                )
            if channels != 1 and channels != wav_channels:
                raise ValueError(
                    f"WAV input has {wav_channels} channel(s), the request specifies {channels}"
                )
            sample_rate, channels = wav_sample_rate, wav_channels
            raw_input = False
        elif not raw:
            raise ValueError("audio file must be a WAV file; pass raw=True for raw audio bytes")
        elif encoding != "linear16":
            raise ValueError("raw transcription uploads require encoding='linear16'")
    if not data:
        raise ValueError("no audio to submit")

    params = SessionParams(
        encoding=encoding,
        sample_rate=sample_rate,
        channels=channels,
        multichannel=multichannel,
        model=model,
        redact_pii=redact_pii,
        redact_pii_sub=redact_pii_sub,
        redact_pii_return=redact_pii_return,
        keywords=keywords,
    )
    query = params.query(transcribe_raw=raw_input)
    _callback_query(
        query,
        callback_url=callback_url,
        callback_auth_header_name=callback_auth_header_name,
        callback_auth_header_value=callback_auth_header_value,
    )
    content_type = TRANSCRIBE_RAW_CONTENT_TYPE if raw_input else TRANSCRIBE_WAV_CONTENT_TYPE
    return data, content_type, query


def _url_query(
    *,
    encoding: Literal["linear16"] | None,
    sample_rate: int | None,
    channels: int | None,
    multichannel: bool,
    model: str | None,
    redact_pii: bool,
    redact_pii_sub: str | None,
    redact_pii_return: bool,
    keywords: Sequence[str] | None,
    raw: bool,
    callback_url: str | None,
    callback_auth_header_name: str | None,
    callback_auth_header_value: str | None,
) -> list[tuple[str, str]]:
    effective_encoding = encoding or "linear16"
    effective_sample_rate = sample_rate or 16000
    effective_channels = channels if channels is not None else 1
    params = SessionParams(
        encoding=effective_encoding,
        sample_rate=effective_sample_rate,
        channels=effective_channels,
        multichannel=multichannel,
        model=model,
        redact_pii=redact_pii,
        redact_pii_sub=redact_pii_sub,
        redact_pii_return=redact_pii_return,
        keywords=keywords,
    )
    query = params.query(transcribe_raw=raw)
    if not raw:
        query = [
            (name, value)
            for name, value in query
            if name != "channels" or channels is not None or multichannel
        ]
        prefix: list[tuple[str, str]] = []
        if encoding is not None:
            prefix.append(("encoding", encoding))
        if sample_rate is not None:
            prefix.append(("sample_rate", str(sample_rate)))
        query = prefix + query
    _callback_query(
        query,
        callback_url=callback_url,
        callback_auth_header_name=callback_auth_header_name,
        callback_auth_header_value=callback_auth_header_value,
    )
    return query


def _job_item_url(base_url: str, job_id: str) -> str:
    if not job_id:
        raise ValueError("id must not be empty")
    collection = build_transcriptions_url(base_url, query=[])
    parts = urlsplit(collection)
    path = parts.path.rstrip("/") + "/" + quote(job_id, safe="")
    return urlunsplit((parts.scheme, parts.netloc, path, parts.query, ""))


def _terminal_result(job: TranscriptionJob, api_key: str) -> Transcription | None:
    if job.status == "completed":
        if job.result is None:
            raise ProtocolError("completed transcription job has no result")
        return job.result
    if job.status == "error":
        if job.error is None:
            raise ProtocolError("error transcription job has no error detail")
        message = job.error.message.replace(api_key, "[redacted]") if api_key else job.error.message
        raise TranscriptionJobError(job.error.code, message)
    return None


class TranscriptionsClient:
    """Synchronous client for asynchronous transcription jobs."""

    def __init__(self, base_url: str, api_key: Callable[[], str]) -> None:
        self._base_url = base_url
        self._api_key = api_key

    def submit(
        self,
        audio: AudioInput,
        *,
        encoding: Literal["linear16"] = "linear16",
        sample_rate: int = 16000,
        channels: int = 1,
        multichannel: bool = False,
        model: str | None = None,
        redact_pii: bool = False,
        redact_pii_sub: str | None = None,
        redact_pii_return: bool = False,
        keywords: Sequence[str] | None = None,
        raw: bool = False,
        callback_url: str | None = None,
        callback_auth_header_name: str | None = None,
        callback_auth_header_value: str | None = None,
        timeout: float = _DEFAULT_JOB_TIMEOUT,
    ) -> TranscriptionJobSubmission:
        """Submit WAV, raw bytes, or a binary file object for processing."""
        _check_timeout(timeout)
        data, content_type, query = _prepare_upload(
            audio,
            encoding=encoding,
            sample_rate=sample_rate,
            channels=channels,
            multichannel=multichannel,
            model=model,
            redact_pii=redact_pii,
            redact_pii_sub=redact_pii_sub,
            redact_pii_return=redact_pii_return,
            keywords=keywords,
            raw=raw,
            callback_url=callback_url,
            callback_auth_header_name=callback_auth_header_name,
            callback_auth_header_value=callback_auth_header_value,
        )
        request_url = build_transcriptions_url(self._base_url, query=query)
        return _http.submit_job(
            request_url,
            self._api_key(),
            data=data,
            content_type=content_type,
            timeout=timeout,
        )

    def submit_url(
        self,
        url: str,
        *,
        encoding: Literal["linear16"] | None = None,
        sample_rate: int | None = None,
        channels: int | None = None,
        multichannel: bool = False,
        model: str | None = None,
        redact_pii: bool = False,
        redact_pii_sub: str | None = None,
        redact_pii_return: bool = False,
        keywords: Sequence[str] | None = None,
        raw: bool = False,
        callback_url: str | None = None,
        callback_auth_header_name: str | None = None,
        callback_auth_header_value: str | None = None,
        timeout: float = _DEFAULT_JOB_TIMEOUT,
    ) -> TranscriptionJobSubmission:
        """Submit an HTTPS audio URL for processing."""
        _check_timeout(timeout)
        query = _url_query(
            encoding=encoding,
            sample_rate=sample_rate,
            channels=channels,
            multichannel=multichannel,
            model=model,
            redact_pii=redact_pii,
            redact_pii_sub=redact_pii_sub,
            redact_pii_return=redact_pii_return,
            keywords=keywords,
            raw=raw,
            callback_url=callback_url,
            callback_auth_header_name=callback_auth_header_name,
            callback_auth_header_value=callback_auth_header_value,
        )
        request_url = build_transcriptions_url(self._base_url, query=query)
        body = json.dumps({"audio_url": url}, separators=(",", ":")).encode("utf-8")
        return _http.submit_job(
            request_url,
            self._api_key(),
            data=body,
            content_type="application/json",
            timeout=timeout,
        )

    def get(self, id: str, *, timeout: float = _DEFAULT_JOB_TIMEOUT) -> TranscriptionJob:
        """Return the current status for a transcription job."""
        _check_timeout(timeout)
        return _http.get_job(_job_item_url(self._base_url, id), self._api_key(), timeout=timeout)

    def wait(
        self,
        id: str,
        *,
        poll_interval: float = 2.0,
        timeout: float = _DEFAULT_WAIT_TIMEOUT,
    ) -> Transcription:
        """Poll until a job completes and return its typed transcription result."""
        if not math.isfinite(poll_interval) or poll_interval < 0:
            raise ValueError("poll_interval must be a non-negative finite number")
        _check_timeout(timeout)
        api_key = self._api_key()
        deadline = time.monotonic() + timeout
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError(f"transcription job wait timed out after {timeout:g}s")
            job = self.get(id, timeout=min(_DEFAULT_JOB_TIMEOUT, remaining))
            result = _terminal_result(job, api_key)
            if result is not None:
                return result
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError(f"transcription job wait timed out after {timeout:g}s")
            time.sleep(min(poll_interval, remaining))

    def delete(self, id: str, *, timeout: float = _DEFAULT_JOB_TIMEOUT) -> None:
        """Delete a transcription job."""
        _check_timeout(timeout)
        _http.delete_job(_job_item_url(self._base_url, id), self._api_key(), timeout=timeout)


class AsyncTranscriptionsClient:
    """Asynchronous client for asynchronous transcription jobs."""

    def __init__(self, base_url: str, api_key: Callable[[], str]) -> None:
        self._sync = TranscriptionsClient(base_url, api_key)

    async def submit(
        self,
        audio: AudioInput,
        *,
        encoding: Literal["linear16"] = "linear16",
        sample_rate: int = 16000,
        channels: int = 1,
        multichannel: bool = False,
        model: str | None = None,
        redact_pii: bool = False,
        redact_pii_sub: str | None = None,
        redact_pii_return: bool = False,
        keywords: Sequence[str] | None = None,
        raw: bool = False,
        callback_url: str | None = None,
        callback_auth_header_name: str | None = None,
        callback_auth_header_value: str | None = None,
        timeout: float = _DEFAULT_JOB_TIMEOUT,
    ) -> TranscriptionJobSubmission:
        return await asyncio.to_thread(
            self._sync.submit,
            audio,
            encoding=encoding,
            sample_rate=sample_rate,
            channels=channels,
            multichannel=multichannel,
            model=model,
            redact_pii=redact_pii,
            redact_pii_sub=redact_pii_sub,
            redact_pii_return=redact_pii_return,
            keywords=keywords,
            raw=raw,
            callback_url=callback_url,
            callback_auth_header_name=callback_auth_header_name,
            callback_auth_header_value=callback_auth_header_value,
            timeout=timeout,
        )

    async def submit_url(
        self,
        url: str,
        *,
        encoding: Literal["linear16"] | None = None,
        sample_rate: int | None = None,
        channels: int | None = None,
        multichannel: bool = False,
        model: str | None = None,
        redact_pii: bool = False,
        redact_pii_sub: str | None = None,
        redact_pii_return: bool = False,
        keywords: Sequence[str] | None = None,
        raw: bool = False,
        callback_url: str | None = None,
        callback_auth_header_name: str | None = None,
        callback_auth_header_value: str | None = None,
        timeout: float = _DEFAULT_JOB_TIMEOUT,
    ) -> TranscriptionJobSubmission:
        return await asyncio.to_thread(
            self._sync.submit_url,
            url,
            encoding=encoding,
            sample_rate=sample_rate,
            channels=channels,
            multichannel=multichannel,
            model=model,
            redact_pii=redact_pii,
            redact_pii_sub=redact_pii_sub,
            redact_pii_return=redact_pii_return,
            keywords=keywords,
            raw=raw,
            callback_url=callback_url,
            callback_auth_header_name=callback_auth_header_name,
            callback_auth_header_value=callback_auth_header_value,
            timeout=timeout,
        )

    async def get(self, id: str, *, timeout: float = _DEFAULT_JOB_TIMEOUT) -> TranscriptionJob:
        return await asyncio.to_thread(self._sync.get, id, timeout=timeout)

    async def wait(
        self,
        id: str,
        *,
        poll_interval: float = 2.0,
        timeout: float = _DEFAULT_WAIT_TIMEOUT,
    ) -> Transcription:
        if not math.isfinite(poll_interval) or poll_interval < 0:
            raise ValueError("poll_interval must be a non-negative finite number")
        _check_timeout(timeout)
        api_key = self._sync._api_key()
        deadline = time.monotonic() + timeout
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError(f"transcription job wait timed out after {timeout:g}s")
            job = await self.get(id, timeout=min(_DEFAULT_JOB_TIMEOUT, remaining))
            result = _terminal_result(job, api_key)
            if result is not None:
                return result
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError(f"transcription job wait timed out after {timeout:g}s")
            await asyncio.sleep(min(poll_interval, remaining))

    async def delete(self, id: str, *, timeout: float = _DEFAULT_JOB_TIMEOUT) -> None:
        await asyncio.to_thread(self._sync.delete, id, timeout=timeout)
