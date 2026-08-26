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
from ._wire import API_KEY_HEADER, SessionParams, build_transcribe_url
from .errors import (
    AuthenticationError,
    BwSttError,
    InvalidRequestError,
    RateLimitError,
    ServiceUnavailableError,
)
from .events import Transcription, parse_transcription


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
    redact_pii_policies: Sequence[str] | None,
    redact_pii_sub: str | None,
    keywords: Sequence[str] | None,
    raw: bool,
    timeout: float,
) -> Transcription:
    if timeout <= 0:
        raise ValueError("timeout must be positive")
    if isinstance(audio, (str, Path)):
        if raw:
            data = Path(audio).read_bytes()
        else:
            if encoding != "linear16":
                raise ValueError(
                    "WAV input requires encoding='linear16'; pass raw=True to send "
                    "pre-encoded audio bytes"
                )
            data, sample_rate, channels = read_wav_file(audio)
    else:
        data = bytes(audio)
    if not data:
        raise ValueError("no audio to transcribe")
    params = SessionParams(
        encoding=encoding,
        sample_rate=sample_rate,
        channels=channels,
        multichannel=multichannel,
        model=model,
        redact_pii=redact_pii,
        redact_pii_policies=redact_pii_policies,
        redact_pii_sub=redact_pii_sub,
        keywords=keywords,
    )
    return _post(build_transcribe_url(base_url, params), api_key, data, timeout)


def _post(url: str, api_key: str, data: bytes, timeout: float) -> Transcription:
    request = urllib.request.Request(
        url,
        data=data,
        method="POST",
        headers={API_KEY_HEADER: api_key, "Content-Type": "application/octet-stream"},
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            body = response.read()
    except urllib.error.HTTPError as exc:
        raise _map_http_error(exc) from exc
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


def _error_detail(exc: urllib.error.HTTPError) -> str:
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
            return f": {message}"
    return ""


def _map_http_error(exc: urllib.error.HTTPError) -> BwSttError:
    status = exc.code
    if status in (401, 403):
        return AuthenticationError(f"API key rejected (HTTP {status})")
    if status == 429:
        return RateLimitError(
            "rate limited (HTTP 429)", retry_after=parse_retry_after(exc.headers.get("Retry-After"))
        )
    if status == 400:
        return InvalidRequestError(f"invalid transcribe request (HTTP 400){_error_detail(exc)}")
    if status == 413:
        return InvalidRequestError(
            "audio too large (HTTP 413); transcribe accepts up to about 5 minutes of audio"
        )
    if status >= 500:
        return ServiceUnavailableError(f"service unavailable (HTTP {status})")
    detail = _error_detail(exc)
    return InvalidRequestError(f"unexpected transcribe response (HTTP {status}){detail}")
