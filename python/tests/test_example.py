from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

import pytest

from .conftest import ServerFactory

EXAMPLE = Path(__file__).resolve().parent.parent / "examples" / "transcribe_wav.py"
SRC = Path(__file__).resolve().parent.parent / "src"


@pytest.mark.example
def test_example_runs_against_mock(mock_server: ServerFactory, wav_file: Path) -> None:
    server = mock_server()
    env = dict(os.environ)
    env["BW_STT_API_KEY"] = "bwa_key_test"
    env["BW_STT_BASE_URL"] = server.url
    env["PYTHONPATH"] = str(SRC)
    completed = subprocess.run(
        [sys.executable, str(EXAMPLE), str(wav_file)],
        env=env,
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert completed.returncode == 0, completed.stderr
    assert "i need a dry van" in completed.stdout
    assert "--- performance ---" in completed.stdout
    assert "RTF:" in completed.stdout
