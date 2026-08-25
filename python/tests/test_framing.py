from __future__ import annotations

from pathlib import Path

import pytest

from bw_stt._framing import (
    FrameChunker,
    frame_bytes,
    iter_raw_chunks,
    iter_wav_chunks,
    read_wav_file,
    validate_frame,
)

from .conftest import write_wav


def test_frame_byte_math() -> None:
    assert frame_bytes("linear16", 16000, 1, 160) == 5120
    assert frame_bytes("linear16", 16000, 2, 160) == 10240
    assert frame_bytes("linear16", 8000, 1, 160) == 2560
    assert frame_bytes("mulaw", 8000, 1, 160) == 1280
    assert frame_bytes("alaw", 8000, 2, 160) == 2560
    assert frame_bytes("g722", 16000, 1, 160) == 1280


def test_chunker_emits_exact_160ms_frames() -> None:
    chunker = FrameChunker("linear16", 16000, 1)
    assert chunker.frame_bytes == 5120
    frames = chunker.feed(b"\0" * 5120 * 2 + b"\0" * 2560)
    assert [len(f) for f in frames] == [5120, 5120]
    assert chunker.finish() == b"\0" * 2560  # 80 ms tail


def test_chunker_odd_chunk_sizes() -> None:
    chunker = FrameChunker("linear16", 16000, 1)
    collected: list[bytes] = []
    for size in (1, 5121, 3, 5119, 5116):  # 15,360 bytes total = exactly 3 frames
        collected.extend(chunker.feed(b"\0" * size))
    assert [len(f) for f in collected] == [5120, 5120, 5120]
    assert chunker.finish() is None


def test_chunker_short_tail_rejected() -> None:
    chunker = FrameChunker("linear16", 16000, 1)
    chunker.feed(b"\0" * (5120 + 100))  # leftover 100 bytes = 3.125 ms
    with pytest.raises(ValueError, match="20 ms"):
        chunker.finish()


def test_chunker_misaligned_tail_rejected() -> None:
    chunker = FrameChunker("linear16", 16000, 1)
    chunker.feed(b"\0" * 5121)
    with pytest.raises(ValueError, match="complete"):
        chunker.finish()


def test_chunker_minimum_tail_accepted() -> None:
    chunker = FrameChunker("linear16", 16000, 1)
    chunker.feed(b"\0" * 640)  # exactly 20 ms
    assert chunker.finish() == b"\0" * 640


def test_chunker_rejects_opus() -> None:
    with pytest.raises(ValueError, match=r"[Oo]pus"):
        FrameChunker("opus", 16000, 1)


def test_validate_frame_bounds() -> None:
    validate_frame(b"\0" * 640, "linear16", 16000, 1)  # 20 ms
    validate_frame(b"\0" * 32000, "linear16", 16000, 1)  # 1000 ms
    with pytest.raises(ValueError, match="at least"):
        validate_frame(b"\0" * 638, "linear16", 16000, 1)
    with pytest.raises(ValueError, match="at most"):
        validate_frame(b"\0" * 32002, "linear16", 16000, 1)
    with pytest.raises(ValueError, match="complete"):
        validate_frame(b"\0" * 641, "linear16", 16000, 1)
    with pytest.raises(ValueError):
        validate_frame(b"", "linear16", 16000, 1)


def test_validate_frame_stereo_alignment() -> None:
    validate_frame(b"\0" * 1280, "linear16", 16000, 2)  # 20 ms stereo
    with pytest.raises(ValueError, match="complete"):
        validate_frame(b"\0" * 1282, "linear16", 16000, 2)


def test_validate_frame_g722() -> None:
    validate_frame(b"\0" * 1280, "g722", 16000, 1)  # 160 ms
    validate_frame(b"\0" * 160, "g722", 16000, 1)  # 20 ms
    with pytest.raises(ValueError, match="at least"):
        validate_frame(b"\0" * 159, "g722", 16000, 1)


def test_validate_frame_opus_skips_duration_rules() -> None:
    validate_frame(b"\x01\x02\x03", "opus", 16000, 1)
    with pytest.raises(ValueError):
        validate_frame(b"", "opus", 16000, 1)


def test_iter_wav_chunks(tmp_path: Path) -> None:
    path = tmp_path / "a.wav"
    payload = write_wav(path, seconds=0.5)
    chunks = list(iter_wav_chunks(path, "linear16", 16000, 1))
    assert b"".join(chunks) == payload
    assert all(len(c) <= 5120 for c in chunks)


def test_iter_wav_chunks_header_mismatch(tmp_path: Path) -> None:
    path = tmp_path / "a.wav"
    write_wav(path, seconds=0.5, sample_rate=8000)
    with pytest.raises(ValueError, match="8000 Hz"):
        iter_wav_chunks(path, "linear16", 16000, 1)
    write_wav(path, seconds=0.5, channels=2)
    with pytest.raises(ValueError, match="channel"):
        iter_wav_chunks(path, "linear16", 16000, 1)


def test_iter_wav_chunks_requires_linear16(tmp_path: Path) -> None:
    path = tmp_path / "a.wav"
    write_wav(path, seconds=0.5)
    with pytest.raises(ValueError, match="linear16"):
        iter_wav_chunks(path, "mulaw", 8000, 1)


def test_iter_wav_chunks_rejects_non_wav(tmp_path: Path) -> None:
    path = tmp_path / "a.wav"
    path.write_bytes(b"not a wav file")
    with pytest.raises(ValueError, match="WAV"):
        iter_wav_chunks(path, "linear16", 16000, 1)


def test_read_wav_file(tmp_path: Path) -> None:
    path = tmp_path / "a.wav"
    payload = write_wav(path, seconds=0.25, sample_rate=8000, channels=2)
    data, rate, channels = read_wav_file(path)
    assert data == payload
    assert rate == 8000
    assert channels == 2


def test_iter_raw_chunks(tmp_path: Path) -> None:
    path = tmp_path / "a.pcm"
    path.write_bytes(b"\x01" * 100_000)
    assert b"".join(iter_raw_chunks(path)) == b"\x01" * 100_000
