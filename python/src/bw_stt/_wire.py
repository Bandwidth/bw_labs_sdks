"""Wire-level constants, connection parameters, and URL building."""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

DEFAULT_BASE_URL = "wss://api.labs.bandwidth.com/audio/v1/listen"
API_KEY_ENV = "BW_STT_API_KEY"
API_KEY_HEADER = "X-BW-LABS-API-KEY"

# Provisional wire names for PII redaction, keyword boosting, and the offline
# transcribe route; the serving contract may still adjust them.
PARAM_REDACT_PII = "redact_pii"
PARAM_REDACT_PII_POLICIES = "redact_pii_policies"
PARAM_REDACT_PII_SUB = "redact_pii_sub"
PARAM_KEYWORDS = "keywords"
LISTEN_PATH_SUFFIX = "/listen"
TRANSCRIBE_PATH_SUFFIX = "/transcribe"

MAX_KEYWORDS = 100

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
    mode: str | None = None
    redact_pii: bool = False
    redact_pii_policies: Sequence[str] | None = None
    redact_pii_sub: str | None = None
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
        if self.mode is not None and not self.mode:
            raise ValueError("mode must be a non-empty string")
        if self.redact_pii_sub is not None and not self.redact_pii_sub:
            raise ValueError("redact_pii_sub must be a non-empty string")
        if self.keywords is not None:
            if len(self.keywords) > MAX_KEYWORDS:
                raise ValueError(f"at most {MAX_KEYWORDS} keywords are allowed")
            for keyword in self.keywords:
                if not isinstance(keyword, str) or not keyword.strip():
                    raise ValueError("keywords must be non-empty strings")

    def query(self) -> list[tuple[str, str]]:
        pairs = [
            ("encoding", self.encoding),
            ("sample_rate", str(self.sample_rate)),
            ("channels", str(self.channels)),
        ]
        if self.multichannel:
            pairs.append(("multichannel", "true"))
        if self.model is not None:
            pairs.append(("model", self.model))
        if self.mode is not None:
            pairs.append(("mode", self.mode))
        if self.redact_pii:
            pairs.append((PARAM_REDACT_PII, "true"))
        if self.redact_pii_policies:
            pairs.append((PARAM_REDACT_PII_POLICIES, ",".join(self.redact_pii_policies)))
        if self.redact_pii_sub is not None:
            pairs.append((PARAM_REDACT_PII_SUB, self.redact_pii_sub))
        if self.keywords:
            pairs.extend((PARAM_KEYWORDS, keyword) for keyword in self.keywords)
        return pairs


def build_ws_url(base_url: str, params: SessionParams) -> str:
    """Append session parameters to the WebSocket endpoint URL."""
    parts = urlsplit(base_url)
    if parts.scheme not in ("ws", "wss"):
        raise ValueError("base_url must use ws:// or wss://")
    existing = parse_qsl(parts.query, keep_blank_values=True)
    query = urlencode(existing + params.query())
    return urlunsplit((parts.scheme, parts.netloc, parts.path, query, ""))


def build_transcribe_url(base_url: str, params: SessionParams) -> str:
    """Derive the HTTPS transcribe URL from the WebSocket base URL."""
    parts = urlsplit(base_url)
    scheme = {"ws": "http", "wss": "https"}.get(parts.scheme)
    if scheme is None:
        raise ValueError("base_url must use ws:// or wss://")
    path = parts.path
    if path.endswith(LISTEN_PATH_SUFFIX):
        path = path[: -len(LISTEN_PATH_SUFFIX)] + TRANSCRIBE_PATH_SUFFIX
    else:
        path = path.rstrip("/") + TRANSCRIBE_PATH_SUFFIX
    existing = parse_qsl(parts.query, keep_blank_values=True)
    query = urlencode(existing + params.query())
    return urlunsplit((scheme, parts.netloc, path, query, ""))
