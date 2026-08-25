from __future__ import annotations

from urllib.parse import parse_qsl, urlsplit

import pytest

from bw_stt._wire import SessionParams, build_transcribe_url, build_ws_url

BASE = "wss://api.labs.bandwidth.com/audio/v1/listen"


def query_of(url: str) -> list[tuple[str, str]]:
    return parse_qsl(urlsplit(url).query, keep_blank_values=True)


def test_default_url_params() -> None:
    url = build_ws_url(BASE, SessionParams())
    parts = urlsplit(url)
    assert parts.scheme == "wss"
    assert parts.path == "/audio/v1/listen"
    query = dict(query_of(url))
    assert query == {"encoding": "linear16", "sample_rate": "16000", "channels": "1"}


def test_full_param_set() -> None:
    params = SessionParams(
        encoding="mulaw",
        sample_rate=8000,
        channels=2,
        multichannel=True,
        model="tag-1",
        mode="instant",
    )
    query = dict(query_of(build_ws_url(BASE, params)))
    assert query["encoding"] == "mulaw"
    assert query["sample_rate"] == "8000"
    assert query["channels"] == "2"
    assert query["multichannel"] == "true"
    assert query["model"] == "tag-1"
    assert query["mode"] == "instant"


def test_mode_demand_in_url() -> None:
    query = dict(query_of(build_ws_url(BASE, SessionParams(mode="demand"))))
    assert query["mode"] == "demand"


def test_pii_params() -> None:
    params = SessionParams(
        redact_pii=True,
        redact_pii_policies=["ssn", "credit_card"],
        redact_pii_sub="hash",
    )
    query = dict(query_of(build_ws_url(BASE, params)))
    assert query["redact_pii"] == "true"
    assert query["redact_pii_policies"] == "ssn,credit_card"
    assert query["redact_pii_sub"] == "hash"


def test_pii_params_absent_by_default() -> None:
    query = dict(query_of(build_ws_url(BASE, SessionParams())))
    for name in ("redact_pii", "redact_pii_policies", "redact_pii_sub", "keywords"):
        assert name not in query


def test_keywords_repeated_and_encoded() -> None:
    params = SessionParams(keywords=["dry van", "reefer", "LTL & FTL"])
    query = query_of(build_ws_url(BASE, params))
    keywords = [value for name, value in query if name == "keywords"]
    assert keywords == ["dry van", "reefer", "LTL & FTL"]
    raw = urlsplit(build_ws_url(BASE, params)).query
    assert raw.count("keywords=") == 3


def test_keyword_validation() -> None:
    with pytest.raises(ValueError, match="100"):
        SessionParams(keywords=["k"] * 101)
    with pytest.raises(ValueError, match="non-empty"):
        SessionParams(keywords=["ok", "  "])
    assert SessionParams(keywords=["k"] * 100).keywords is not None


@pytest.mark.parametrize(
    "kwargs",
    [
        {"encoding": "mp3"},
        {"sample_rate": 44100},
        {"channels": 3},
        {"multichannel": True, "channels": 1},
        {"encoding": "g722", "sample_rate": 8000},
        {"encoding": "opus", "channels": 2},
        {"model": ""},
        {"mode": ""},
    ],
)
def test_param_validation(kwargs: dict[str, object]) -> None:
    with pytest.raises(ValueError):
        SessionParams(**kwargs)  # type: ignore[arg-type]


def test_base_url_scheme_required() -> None:
    with pytest.raises(ValueError, match="ws://"):
        build_ws_url("https://api.labs.bandwidth.com/audio/v1/listen", SessionParams())


def test_base_url_existing_query_preserved() -> None:
    url = build_ws_url(BASE + "?api_key=bwa_key_x", SessionParams())
    query = dict(query_of(url))
    assert query["api_key"] == "bwa_key_x"
    assert query["encoding"] == "linear16"


def test_transcribe_url_derivation() -> None:
    url = build_transcribe_url(BASE, SessionParams())
    parts = urlsplit(url)
    assert parts.scheme == "https"
    assert parts.path == "/audio/v1/transcribe"
    assert dict(query_of(url))["encoding"] == "linear16"

    url = build_transcribe_url("ws://127.0.0.1:9999", SessionParams())
    parts = urlsplit(url)
    assert parts.scheme == "http"
    assert parts.path == "/transcribe"
