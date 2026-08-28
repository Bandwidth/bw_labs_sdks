from __future__ import annotations

import gc
import os
import subprocess
import sys
import textwrap
from pathlib import Path

import pytest

from bw_stt import AuthenticationError, BwSttClient, Session, TranscriptAssembler

from .conftest import ServerFactory, wait_until

AUDIO_160MS = b"\0" * 5120
SRC = Path(__file__).resolve().parent.parent / "src"


def test_session_keeps_loop_alive_without_client_reference(
    mock_server: ServerFactory, api_key_env: str
) -> None:
    server = mock_server()

    def make_session() -> Session:
        client = BwSttClient(base_url=server.url)
        return client.connect()

    session = make_session()
    gc.collect()
    transcript = TranscriptAssembler()
    session.on_segment(transcript.push)
    session.send_audio(AUDIO_160MS)
    closed = session.close_stream()
    assert closed.request_id == "req-1"
    assert transcript.text == "i need a dry van"

    client = session._client
    assert client._loop_thread is not None
    loop_thread = client._loop_thread._thread
    assert loop_thread.is_alive()
    del client
    del session
    gc.collect()
    wait_until(lambda: not loop_thread.is_alive(), timeout=10.0)


def test_client_close_abrupt_closes_sessions(mock_server: ServerFactory, api_key_env: str) -> None:
    server = mock_server()
    client = BwSttClient(base_url=server.url)
    session = client.connect()
    assert session.is_open
    assert client._loop_thread is not None
    loop_thread = client._loop_thread._thread
    client.close()
    assert not session.is_open
    assert not loop_thread.is_alive()
    client.close()


def test_client_context_manager(mock_server: ServerFactory, api_key_env: str) -> None:
    server = mock_server()
    with BwSttClient(base_url=server.url) as client:
        session = client.connect()
        session.send_audio(AUDIO_160MS)
        assert session.is_open
    assert not session.is_open


def test_empty_api_key_does_not_fall_back_to_env(
    mock_server: ServerFactory, api_key_env: str
) -> None:
    server = mock_server()
    client = BwSttClient(api_key="", base_url=server.url)
    with pytest.raises(AuthenticationError, match="empty"):
        client.connect()


def test_empty_api_key_transcribe(api_key_env: str) -> None:
    client = BwSttClient(api_key="")
    with pytest.raises(AuthenticationError, match="empty"):
        client.transcribe(b"\0" * 3200)


def test_interpreter_exit_with_open_session_is_quiet(
    mock_server: ServerFactory, api_key_env: str
) -> None:
    server = mock_server()
    script = textwrap.dedent(
        f"""
        from bw_stt import BwSttClient

        client = BwSttClient(api_key="bwa_key_test", base_url={server.url!r})
        session = client.connect()
        session.send_audio(b"\\0" * 5120)
        """
    )
    env = dict(os.environ)
    env["PYTHONPATH"] = str(SRC)
    completed = subprocess.run(
        [sys.executable, "-c", script],
        env=env,
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert completed.returncode == 0, completed.stderr
    assert "Task was destroyed" not in completed.stderr
    assert "Event loop is closed" not in completed.stderr
    assert "Traceback" not in completed.stderr
