"""Wire-level constants, connection parameters, and URL building."""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Literal
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

DEFAULT_BASE_URL = "wss://api.labs.bandwidth.com/audio/v1/listen"
API_KEY_ENV = "BW_STT_API_KEY"
API_KEY_HEADER = "X-BW-LABS-API-KEY"

# Wire names and offline media rules confirmed against the transcription service
# contract. Keep SDK-to-wire mapping in this module.
PARAM_REDACT_PII = "redact_pii"
PARAM_REDACT_PII_SUB = "redact_pii_sub"
PARAM_REDACT_PII_RETURN = "redact_pii_return"
PARAM_KEYWORDS = "keywords"
LISTEN_PATH = "/audio/v1/listen"
TRANSCRIBE_PATH = "/audio/v1/transcribe"
TRANSCRIPTIONS_PATH = "/audio/v1/transcriptions"
LISTEN_PATH_SUFFIX = "/listen"
TRANSCRIBE_PATH_SUFFIX = "/transcribe"
TRANSCRIPTIONS_PATH_SUFFIX = "/transcriptions"
TRANSCRIBE_WAV_CONTENT_TYPE = "audio/wav"
TRANSCRIBE_RAW_CONTENT_TYPE = "application/octet-stream"
TRANSCRIBE_RAW_ENCODING = "linear16"
TRANSCRIBE_MAX_AUDIO_DESCRIPTION = "five minutes"
CALLBACK_URL_PARAM = "callback_url"
CALLBACK_AUTH_HEADER_NAME_PARAM = "callback_auth_header_name"
CALLBACK_AUTH_HEADER_VALUE_PARAM = "callback_auth_header_value"

_WS_SCHEMES = {"ws": "ws", "wss": "wss", "http": "ws", "https": "wss"}
_HTTP_SCHEMES = {"ws": "http", "wss": "https", "http": "http", "https": "https"}

MAX_KEYWORDS = 100
MAX_KEYWORD_BYTES = 4096

ENCODINGS = frozenset({"linear16", "mulaw", "alaw", "g722", "opus"})
SAMPLE_RATES = frozenset({8000, 16000})

KEEP_ALIVE_JSON = '{"type":"KeepAlive"}'
FINALIZE_JSON = '{"type":"Finalize"}'
CLOSE_STREAM_JSON = '{"type":"CloseStream"}'


@dataclass(frozen=True)
class SessionParams:
    """Validated connection parameters shared by streaming and transcribe."""

    encoding: str = "linear16"
    sample_rate: int = 16000
    channels: int = 1
    multichannel: bool = False
    model: str | None = None
    mode: Literal["instant", "demand"] | None = None
    redact_pii: bool = False
    redact_pii_sub: str | None = None
    redact_pii_return: bool = False
    keywords: Sequence[str] | None = None

    def __post_init__(self) -> None:
        if self.encoding not in ENCODINGS:
            raise ValueError(f"encoding must be one of {sorted(ENCODINGS)}, not {self.encoding!r}")
        if self.sample_rate not in SAMPLE_RATES:
            raise ValueError(f"sample_rate must be one of {sorted(SAMPLE_RATES)}")
        if self.channels not in (1, 2):
            raise ValueError("channels must be 1 or 2")
        if self.multichannel and self.channels != 2:
            raise ValueError("multichannel=True requires channels=2")
        if self.encoding in ("g722", "opus"):
            if self.sample_rate != 16000:
                raise ValueError(f"{self.encoding} requires sample_rate=16000")
            if self.channels != 1:
                raise ValueError(f"{self.encoding} requires channels=1")
        if self.model is not None and not self.model:
            raise ValueError("model must be a non-empty string")
        if self.mode is not None and self.mode not in ("instant", "demand"):
            raise ValueError("mode must be instant or demand")
        if self.redact_pii_sub is not None and not self.redact_pii_sub:
            raise ValueError("redact_pii_sub must be a non-empty string")
        if self.redact_pii_return and not self.redact_pii:
            raise ValueError("redact_pii_return requires redact_pii=True")
        if self.redact_pii_return and self.redact_pii_sub == "entity_name":
            raise ValueError(
                "redact_pii_return cannot be combined with redact_pii_sub='entity_name'"
            )
        if self.keywords is not None:
            if len(self.keywords) > MAX_KEYWORDS:
                raise ValueError(f"at most {MAX_KEYWORDS} keywords are allowed")
            keyword_bytes = 0
            for keyword in self.keywords:
                if not isinstance(keyword, str) or not keyword.strip():
                    raise ValueError("keywords must be non-empty strings")
                keyword_bytes += len(keyword.encode("utf-8"))
            if keyword_bytes > MAX_KEYWORD_BYTES:
                raise ValueError(
                    f"keywords must fit within {MAX_KEYWORD_BYTES} UTF-8 bytes combined"
                )

    def query(self, *, transcribe_raw: bool | None = None) -> list[tuple[str, str]]:
        """Return query parameters for listen or the confirmed transcribe contract.

        ``None`` selects the listen surface. For transcribe, ``True`` selects
        raw linear16 and ``False`` selects a WAV body. The streaming-only mode
        field never crosses the HTTP boundary.
        """
        if transcribe_raw and self.encoding != TRANSCRIBE_RAW_ENCODING:
            raise ValueError("raw transcribe uploads require encoding='linear16'")
        pairs: list[tuple[str, str]] = []
        if transcribe_raw is None or transcribe_raw:
            pairs.extend([("encoding", self.encoding), ("sample_rate", str(self.sample_rate))])
        pairs.append(("channels", str(self.channels)))
        if self.multichannel:
            pairs.append(("multichannel", "true"))
        if self.model is not None:
            pairs.append(("model", self.model))
        if transcribe_raw is None and self.mode is not None:
            pairs.append(("mode", self.mode))
        if self.redact_pii:
            pairs.append((PARAM_REDACT_PII, "true"))
        if self.redact_pii_sub is not None:
            pairs.append((PARAM_REDACT_PII_SUB, self.redact_pii_sub))
        if self.redact_pii_return:
            pairs.append((PARAM_REDACT_PII_RETURN, "true"))
        if self.keywords:
            pairs.extend((PARAM_KEYWORDS, keyword) for keyword in self.keywords)
        return pairs


def build_ws_url(base_url: str, params: SessionParams) -> str:
    """Build the listen URL: normalize the scheme to ws(s) and append parameters.

    A base URL without a path (or with just "/") gets the standard listen
    path appended; a custom path is kept verbatim.
    """
    parts = urlsplit(base_url)
    scheme = _WS_SCHEMES.get(parts.scheme)
    if scheme is None:
        raise ValueError("base_url must use ws, wss, http, or https")
    path = parts.path
    if path in ("", "/"):
        path = LISTEN_PATH
    existing = parse_qsl(parts.query, keep_blank_values=True)
    query = urlencode(existing + params.query())
    return urlunsplit((scheme, parts.netloc, path, query, ""))


def build_transcribe_url(base_url: str, params: SessionParams, *, raw_input: bool = True) -> str:
    """Build the transcribe URL: normalize the scheme to http(s) and derive the path.

    A base URL without a path gets the standard transcribe path appended, a
    path ending in /listen has that suffix replaced with /transcribe, and any
    other custom path gets /transcribe appended.
    """
    parts = urlsplit(base_url)
    scheme = _HTTP_SCHEMES.get(parts.scheme)
    if scheme is None:
        raise ValueError("base_url must use ws, wss, http, or https")
    path = parts.path
    if path in ("", "/"):
        path = TRANSCRIBE_PATH
    elif path.endswith(LISTEN_PATH_SUFFIX):
        path = path[: -len(LISTEN_PATH_SUFFIX)] + TRANSCRIBE_PATH_SUFFIX
    else:
        path = path.rstrip("/") + TRANSCRIBE_PATH_SUFFIX
    existing = parse_qsl(parts.query, keep_blank_values=True)
    query = urlencode(existing + params.query(transcribe_raw=raw_input))
    return urlunsplit((scheme, parts.netloc, path, query, ""))


def build_transcriptions_url(
    base_url: str,
    params: SessionParams | None = None,
    *,
    raw_input: bool | None = True,
    query: Sequence[tuple[str, str]] | None = None,
) -> str:
    """Build the asynchronous transcription jobs collection URL.

    ``query`` is useful for URL sources whose media type is discovered by the
    service. When omitted, parameters are serialized with the same media and
    feature rules as :func:`build_transcribe_url`.
    """
    parts = urlsplit(base_url)
    scheme = _HTTP_SCHEMES.get(parts.scheme)
    if scheme is None:
        raise ValueError("base_url must use ws, wss, http, or https")
    path = parts.path
    if path in ("", "/"):
        path = TRANSCRIPTIONS_PATH
    elif path.endswith(LISTEN_PATH_SUFFIX):
        path = path[: -len(LISTEN_PATH_SUFFIX)] + TRANSCRIPTIONS_PATH_SUFFIX
    elif path.endswith(TRANSCRIBE_PATH_SUFFIX):
        path = path[: -len(TRANSCRIBE_PATH_SUFFIX)] + TRANSCRIPTIONS_PATH_SUFFIX
    elif not path.endswith(TRANSCRIPTIONS_PATH_SUFFIX):
        path = path.rstrip("/") + TRANSCRIPTIONS_PATH_SUFFIX
    if query is None:
        if params is None:
            raise ValueError("params or query is required")
        query = params.query(transcribe_raw=raw_input)
    existing = parse_qsl(parts.query, keep_blank_values=True)
    return urlunsplit((scheme, parts.netloc, path, urlencode(existing + list(query)), ""))


def append_callback_query(
    query: list[tuple[str, str]],
    *,
    callback_url: str | None = None,
    callback_auth_header_name: str | None = None,
    callback_auth_header_value: str | None = None,
) -> None:
    """Append callback parameters using their public wire names."""
    if callback_url is not None:
        query.append((CALLBACK_URL_PARAM, callback_url))
    if callback_auth_header_name is not None:
        query.append((CALLBACK_AUTH_HEADER_NAME_PARAM, callback_auth_header_name))
    if callback_auth_header_value is not None:
        query.append((CALLBACK_AUTH_HEADER_VALUE_PARAM, callback_auth_header_value))
