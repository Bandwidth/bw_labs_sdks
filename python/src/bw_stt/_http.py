"""Offline transcription over HTTP using only the standard library."""

from __future__ import annotations

import json
import urllib.error
import urllib.request
from collections.abc import Sequence
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path

from ._framing import read_wav_file
from ._wire import (
    API_KEY_HEADER,
    TRANSCRIBE_MAX_AUDIO_DESCRIPTION,
    TRANSCRIBE_RAW_CONTENT_TYPE,
    TRANSCRIBE_RAW_ENCODING,
    TRANSCRIBE_WAV_CONTENT_TYPE,
    SessionParams,
    build_transcribe_url,
)
from .errors import (
    AuthenticationError,
    BwSttError,
    InvalidRequestError,
    JobLimitError,
    JobPlatformUnavailableError,
    ProtocolError,
    RateLimitError,
    ServiceUnavailableError,
    TranscriptionNotFoundError,
)
from .events import Transcription, parse_transcription
from .jobs import TranscriptionJob, TranscriptionJobSubmission, parse_job, parse_job_submission


def transcribe(
    base_url: str,
    api_key: str,
    audio: bytes | str | Path,
    *,
    encoding: str,
    sample_rate: int,
    channels: int,
    multichannel: bool,
    model: str | None,
    redact_pii: bool,
    redact_pii_sub: str | None,
    redact_pii_return: bool,
    keywords: Sequence[str] | None,
    raw: bool,
    timeout: float,
) -> Transcription:
    if timeout <= 0:
        raise ValueError("timeout must be positive")
    raw_input = True
    if isinstance(audio, str | Path) and not raw:
        if encoding != TRANSCRIBE_RAW_ENCODING:
            raise ValueError(
                "WAV input requires encoding='linear16'; pass raw=True to send "
                "headerless linear16 audio bytes"
            )
        data = Path(audio).read_bytes()
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
    else:
        data = Path(audio).read_bytes() if isinstance(audio, str | Path) else bytes(audio)
        if encoding != TRANSCRIBE_RAW_ENCODING:
            raise ValueError("raw transcribe uploads require encoding='linear16'")
    if not data:
        raise ValueError("no audio to transcribe")
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
    content_type = TRANSCRIBE_RAW_CONTENT_TYPE if raw_input else TRANSCRIBE_WAV_CONTENT_TYPE
    return _post(
        build_transcribe_url(base_url, params, raw_input=raw_input),
        api_key,
        data,
        content_type,
        timeout,
    )


def _post(url: str, api_key: str, data: bytes, content_type: str, timeout: float) -> Transcription:
    request = urllib.request.Request(
        url,
        data=data,
        method="POST",
        headers={API_KEY_HEADER: api_key, "Content-Type": content_type},
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            body = response.read()
    except urllib.error.HTTPError as exc:
        raise _map_http_error(exc, api_key) from exc
    except urllib.error.URLError as exc:
        if isinstance(exc.reason, TimeoutError):
            raise ServiceUnavailableError(
                f"transcribe request timed out after {timeout:g}s"
            ) from exc
        raise ServiceUnavailableError(f"transcribe request failed: {exc.reason}") from exc
    except TimeoutError as exc:
        raise ServiceUnavailableError(f"transcribe request timed out after {timeout:g}s") from exc
    except OSError as exc:
        raise ServiceUnavailableError(f"transcribe request failed: {exc}") from exc
    return parse_transcription(body)


def parse_retry_after(value: str | None) -> float | None:
    """Parse a Retry-After header: delta-seconds or an HTTP-date, as seconds from now."""
    if value is None:
        return None
    try:
        return float(value)
    except ValueError:
        pass
    try:
        when = parsedate_to_datetime(value)
    except (TypeError, ValueError):
        return None
    if when.tzinfo is None:
        when = when.replace(tzinfo=timezone.utc)
    return max((when - datetime.now(timezone.utc)).total_seconds(), 0.0)


def _error_detail(exc: urllib.error.HTTPError, api_key: str = "") -> str:
    try:
        body = exc.read()
    except OSError:
        return ""
    if not body:
        return ""
    try:
        payload = json.loads(body)
    except ValueError:
        return ""
    if isinstance(payload, dict):
        message = payload.get("message")
        if isinstance(message, str) and message:
            return f": {_safe_job_text(message, api_key)}"
    return ""


def _map_http_error(exc: urllib.error.HTTPError, api_key: str = "") -> BwSttError:
    status = exc.code
    if status in (401, 403):
        return AuthenticationError(f"API key rejected (HTTP {status})")
    if status == 429:
        return RateLimitError(
            "rate limited (HTTP 429)", retry_after=parse_retry_after(exc.headers.get("Retry-After"))
        )
    if status == 400:
        return InvalidRequestError(
            f"invalid transcribe request (HTTP 400){_error_detail(exc, api_key)}"
        )
    if status == 413:
        return InvalidRequestError(
            "audio too large (HTTP 413); transcribe accepts up to "
            f"{TRANSCRIBE_MAX_AUDIO_DESCRIPTION} of audio"
        )
    if status >= 500:
        return ServiceUnavailableError(f"service unavailable (HTTP {status})")
    detail = _error_detail(exc, api_key)
    return InvalidRequestError(f"unexpected transcribe response (HTTP {status}){detail}")


def _safe_job_text(value: str, api_key: str) -> str:
    """Keep customer-controlled error text from echoing the credential."""
    return value.replace(api_key, "[redacted]") if api_key else value


def _job_error_payload(exc: urllib.error.HTTPError) -> tuple[str | None, str | None]:
    try:
        body = exc.read()
    except OSError:
        return None, None
    try:
        payload = json.loads(body)
    except ValueError:
        return None, None
    if not isinstance(payload, dict):
        return None, None
    code = payload.get("code")
    if not isinstance(code, str) or not code:
        code = payload.get("error")
    if not isinstance(code, str) or not code:
        code = None
    message = payload.get("message")
    if not isinstance(message, str) or not message:
        message = None
    return code, message


def _job_detail(default: str, code: str | None, message: str | None, api_key: str) -> str:
    detail = message or code
    if detail:
        return f"{default}: {_safe_job_text(detail, api_key)}"
    return default


def _map_job_http_error(exc: urllib.error.HTTPError, operation: str, api_key: str) -> BwSttError:
    status = exc.code
    code, message = _job_error_payload(exc)
    if status in (401, 403):
        return AuthenticationError(f"API key rejected (HTTP {status})")
    if status == 404:
        return TranscriptionNotFoundError(f"transcription job not found (HTTP {status})")
    if status == 429:
        return JobLimitError(
            _job_detail("transcription job limit reached (HTTP 429)", code, message, api_key),
            retry_after=parse_retry_after(exc.headers.get("Retry-After")),
        )
    if status == 503:
        return JobPlatformUnavailableError(
            _job_detail("transcription job platform unavailable (HTTP 503)", code, message, api_key)
        )
    if status == 400:
        detail = _safe_job_text(message or code or "", api_key)
        suffix = f": {detail}" if detail else ""
        return InvalidRequestError(
            f"{operation} rejected (HTTP 400){suffix}", code=code, status=status
        )
    if status == 413:
        return InvalidRequestError(
            f"{operation} payload is too large (HTTP 413)", code=code, status=status
        )
    if status >= 500:
        return ServiceUnavailableError(f"{operation} unavailable (HTTP {status})")
    detail = _safe_job_text(message or code or "", api_key)
    suffix = f": {detail}" if detail else ""
    return InvalidRequestError(
        f"{operation} rejected (HTTP {status}){suffix}", code=code, status=status
    )


def _request(
    url: str,
    api_key: str,
    *,
    method: str,
    data: bytes | None,
    content_type: str | None,
    timeout: float,
    operation: str,
) -> tuple[int, bytes]:
    headers = {API_KEY_HEADER: api_key}
    if content_type is not None:
        headers["Content-Type"] = content_type
    request = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return int(response.status), response.read()
    except urllib.error.HTTPError as exc:
        raise _map_job_http_error(exc, operation, api_key) from exc
    except urllib.error.URLError as exc:
        reason = _safe_job_text(str(exc.reason), api_key)
        if isinstance(exc.reason, TimeoutError):
            raise ServiceUnavailableError(
                f"{operation} timed out after {timeout:g}s"
            ) from exc
        raise ServiceUnavailableError(f"{operation} failed: {reason}") from exc
    except TimeoutError as exc:
        raise ServiceUnavailableError(f"{operation} timed out after {timeout:g}s") from exc
    except OSError as exc:
        raise ServiceUnavailableError(
            f"{operation} failed: {_safe_job_text(str(exc), api_key)}"
        ) from exc


def submit_job(
    url: str,
    api_key: str,
    *,
    data: bytes,
    content_type: str,
    timeout: float,
) -> TranscriptionJobSubmission:
    status, body = _request(
        url,
        api_key,
        method="POST",
        data=data,
        content_type=content_type,
        timeout=timeout,
        operation="transcription submission",
    )
    if status != 202:
        raise ProtocolError(f"transcription submission returned unexpected HTTP {status}")
    return parse_job_submission(body)


def get_job(url: str, api_key: str, *, timeout: float) -> TranscriptionJob:
    status, body = _request(
        url,
        api_key,
        method="GET",
        data=None,
        content_type=None,
        timeout=timeout,
        operation="transcription job lookup",
    )
    if status != 200:
        raise ProtocolError(f"transcription job lookup returned unexpected HTTP {status}")
    return parse_job(body)


def delete_job(url: str, api_key: str, *, timeout: float) -> None:
    status, _ = _request(
        url,
        api_key,
        method="DELETE",
        data=None,
        content_type=None,
        timeout=timeout,
        operation="transcription job deletion",
    )
    if status != 204:
        raise ProtocolError(f"transcription job deletion returned unexpected HTTP {status}")
