"""Byte math for raw audio frames and local audio file readers."""

from __future__ import annotations

import struct
import wave
from collections.abc import Iterator
from pathlib import Path
from typing import BinaryIO

MIN_FRAME_MS = 20
MAX_FRAME_MS = 1000
CHUNK_MS = 160
_RAW_READ_BYTES = 64 * 1024

WAVE_FORMAT_PCM = 0x0001
WAVE_FORMAT_EXTENSIBLE = 0xFFFE


def sample_align_bytes(encoding: str, channels: int) -> int:
    """Smallest byte count that holds complete interleaved samples."""
    if encoding == "linear16":
        return 2 * channels
    if encoding == "g722":
        return 1  # each byte decodes to two samples, so any byte count is aligned
    return channels


def _samples_per_channel(encoding: str, channels: int, nbytes: int) -> int:
    if encoding == "linear16":
        return nbytes // (2 * channels)
    if encoding == "g722":
        return nbytes * 2
    return nbytes // channels


def frame_bytes(encoding: str, sample_rate: int, channels: int, ms: int) -> int:
    """Byte length of a frame of the given duration."""
    samples = sample_rate * ms // 1000
    if encoding == "linear16":
        return samples * 2 * channels
    if encoding == "g722":
        return samples // 2
    return samples * channels


def validate_frame(data: bytes, encoding: str, sample_rate: int, channels: int) -> None:
    """Check one binary message against the frame rules; raise ValueError if invalid.

    Opus is exempt from the duration rule: each message is one raw encoder
    packet, forwarded as-is.
    """
    if encoding == "opus":
        if not data:
            raise ValueError("an Opus message must carry exactly one non-empty packet")
        return
    align = sample_align_bytes(encoding, channels)
    if not data or len(data) % align:
        raise ValueError(
            f"audio frame of {len(data)} bytes does not hold complete "
            f"{channels}-channel {encoding} samples"
        )
    samples = _samples_per_channel(encoding, channels, len(data))
    duration_ms = samples * 1000 / sample_rate
    # exact integer comparisons: duration >= 20 ms and <= 1000 ms
    if samples * 50 < sample_rate:
        raise ValueError(
            f"audio frame is {duration_ms:g} ms; frames must be at least {MIN_FRAME_MS} ms"
        )
    if samples > sample_rate:
        raise ValueError(
            f"audio frame is {duration_ms:g} ms; frames must be at most {MAX_FRAME_MS} ms"
        )


class FrameChunker:
    """Reframe arbitrary byte chunks into exact 160 ms frames plus a final tail."""

    def __init__(self, encoding: str, sample_rate: int, channels: int) -> None:
        if encoding == "opus":
            raise ValueError(
                "Opus audio is one packet per message and cannot be reframed; "
                "send each packet with send_audio"
            )
        self._encoding = encoding
        self._sample_rate = sample_rate
        self._channels = channels
        self.frame_bytes = frame_bytes(encoding, sample_rate, channels, CHUNK_MS)
        self._buffer = bytearray()

    def feed(self, data: bytes) -> list[bytes]:
        """Add bytes and return every complete 160 ms frame now available."""
        self._buffer.extend(data)
        frames = []
        while len(self._buffer) >= self.frame_bytes:
            frames.append(bytes(self._buffer[: self.frame_bytes]))
            del self._buffer[: self.frame_bytes]
        return frames

    def finish(self) -> bytes | None:
        """Return the final sub-frame tail, or None when nothing is buffered.

        Raises ValueError when the leftover is misaligned or shorter than
        the 20 ms minimum frame.
        """
        if not self._buffer:
            return None
        tail = bytes(self._buffer)
        self._buffer.clear()
        validate_frame(tail, self._encoding, self._sample_rate, self._channels)
        return tail


class _UnsupportedWavFormat(ValueError):
    """A structurally valid WAV file whose sample format this SDK cannot send."""


class _ExtensiblePcmWav:
    """Reader for WAVE_FORMAT_EXTENSIBLE PCM16 files.

    The stdlib wave module rejects the extensible format tag on Python 3.10
    and 3.11; this fallback parses the fmt and data chunks directly and
    exposes the subset of the wave.Wave_read API this SDK uses.
    """

    def __init__(self, path: str | Path) -> None:
        self._data_bytes = 0
        self._file: BinaryIO = open(path, "rb")  # noqa: SIM115 - the reader owns the handle
        try:
            self._parse(path)
        except BaseException:
            self._file.close()
            raise
        self._remaining = self._data_bytes

    def _parse(self, path: str | Path) -> None:
        header = self._file.read(12)
        if len(header) != 12 or header[:4] != b"RIFF" or header[8:12] != b"WAVE":
            raise ValueError(f"{path} is not a readable WAV file: missing RIFF/WAVE header")
        fmt: bytes | None = None
        while True:
            chunk_header = self._file.read(8)
            if len(chunk_header) != 8:
                raise ValueError(f"{path} is not a readable WAV file: no data chunk")
            chunk_id, chunk_size = struct.unpack("<4sI", chunk_header)
            if chunk_id == b"fmt ":
                fmt = self._file.read(chunk_size)
                if chunk_size % 2:
                    self._file.read(1)
            elif chunk_id == b"data":
                if fmt is None:
                    raise ValueError(f"{path} is not a readable WAV file: data before fmt chunk")
                self._check_fmt(fmt, path)
                self._data_bytes = int(chunk_size)
                return
            else:
                self._file.seek(chunk_size + chunk_size % 2, 1)

    def _check_fmt(self, fmt: bytes, path: str | Path) -> None:
        if len(fmt) < 16:
            raise ValueError(f"{path} is not a readable WAV file: truncated fmt chunk")
        format_tag, channels, sample_rate, _, _, bits = struct.unpack("<HHIIHH", fmt[:16])
        if format_tag == WAVE_FORMAT_EXTENSIBLE:
            if len(fmt) < 26:
                raise ValueError(f"{path} is not a readable WAV file: truncated extensible fmt")
            (format_tag,) = struct.unpack("<H", fmt[24:26])
        if format_tag != WAVE_FORMAT_PCM or bits != 16:
            raise _UnsupportedWavFormat(f"{path}: WAV audio must be 16-bit PCM")
        self._channels = int(channels)
        self._sample_rate = int(sample_rate)
        self._frame_size = 2 * self._channels

    def getcomptype(self) -> str:
        return "NONE"

    def getsampwidth(self) -> int:
        return 2

    def getframerate(self) -> int:
        return self._sample_rate

    def getnchannels(self) -> int:
        return self._channels

    def getnframes(self) -> int:
        return self._data_bytes // self._frame_size

    def readframes(self, nframes: int) -> bytes:
        count = min(nframes * self._frame_size, self._remaining)
        data = self._file.read(count)
        self._remaining -= len(data)
        return data

    def close(self) -> None:
        self._file.close()


_WavReader = wave.Wave_read | _ExtensiblePcmWav


def _open_wav(path: str | Path) -> _WavReader:
    try:
        return wave.open(str(path), "rb")
    except (wave.Error, EOFError) as exc:
        try:
            return _ExtensiblePcmWav(path)
        except _UnsupportedWavFormat:
            raise
        except (OSError, ValueError):
            pass
        raise ValueError(f"{path} is not a readable WAV file: {exc}") from exc


def _check_pcm16(reader: _WavReader, path: str | Path) -> None:
    if reader.getcomptype() != "NONE":
        raise ValueError(f"{path}: WAV audio must be uncompressed PCM")
    if reader.getsampwidth() != 2:
        raise ValueError(f"{path}: WAV audio must be 16-bit PCM")


def iter_wav_chunks(
    path: str | Path, encoding: str, sample_rate: int, channels: int
) -> Iterator[bytes]:
    """Validate a WAV header against the session and yield its PCM payload."""
    if encoding != "linear16":
        raise ValueError(
            "WAV input requires a linear16 session; pass raw=True to stream pre-encoded audio bytes"
        )
    reader = _open_wav(path)
    try:
        _check_pcm16(reader, path)
        if reader.getframerate() != sample_rate:
            raise ValueError(
                f"{path} is {reader.getframerate()} Hz but the session uses {sample_rate} Hz"
            )
        if reader.getnchannels() != channels:
            raise ValueError(
                f"{path} has {reader.getnchannels()} channel(s) but the session uses {channels}"
            )
    except Exception:
        reader.close()
        raise

    def chunks() -> Iterator[bytes]:
        try:
            frames_per_read = sample_rate * CHUNK_MS // 1000
            while True:
                data = reader.readframes(frames_per_read)
                if not data:
                    return
                yield data
        finally:
            reader.close()

    return chunks()


def read_wav_file(path: str | Path) -> tuple[bytes, int, int]:
    """Read a PCM16 WAV file; return its payload, sample rate, and channels."""
    reader = _open_wav(path)
    try:
        _check_pcm16(reader, path)
        data = reader.readframes(reader.getnframes())
        return data, reader.getframerate(), reader.getnchannels()
    finally:
        reader.close()


def iter_raw_chunks(path: str | Path) -> Iterator[bytes]:
    """Yield the bytes of a headerless audio file."""

    def chunks() -> Iterator[bytes]:
        with open(path, "rb") as source:
            while data := source.read(_RAW_READ_BYTES):
                yield data

    return chunks()
