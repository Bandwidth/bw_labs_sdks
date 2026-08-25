"""Synchronous client that drives the async client on a background event loop."""

from __future__ import annotations

import asyncio
import threading
import weakref
from collections.abc import Callable, Coroutine, Iterable, Iterator, Sequence
from pathlib import Path
from types import TracebackType
from typing import Any, TypeVar

from . import _http
from ._framing import FrameChunker, iter_raw_chunks, iter_wav_chunks
from ._wire import DEFAULT_BASE_URL
from .aio import AsyncBwSttClient, AsyncSession, _resolve_api_key
from .events import Event, Segment, SessionClosed, SessionOpened, Transcription

__all__ = ["BwSttClient", "Session"]

T = TypeVar("T")


class _EventLoopThread:
    """A dedicated event loop thread shared by the sessions of one client."""

    def __init__(self) -> None:
        self._loop = asyncio.new_event_loop()
        self._thread = threading.Thread(target=self._run, name="bw-stt", daemon=True)
        self._thread.start()

    def _run(self) -> None:
        asyncio.set_event_loop(self._loop)
        self._loop.run_forever()

    def call(self, coro: Coroutine[Any, Any, T]) -> T:
        return asyncio.run_coroutine_threadsafe(coro, self._loop).result()

    def stop(self) -> None:
        try:
            self._loop.call_soon_threadsafe(self._loop.stop)
        except RuntimeError:  # the loop is already closed
            return
        self._thread.join(timeout=5.0)
        if not self._thread.is_alive():
            self._loop.close()


class BwSttClient:
    """Client for the Bandwidth Labs speech-to-text API.

    The API key falls back to the ``BW_STT_API_KEY`` environment variable;
    ``base_url`` defaults to the public endpoint.
    """

    def __init__(self, api_key: str | None = None, base_url: str | None = None) -> None:
        self.api_key = api_key
        self.base_url = base_url or DEFAULT_BASE_URL
        self._async = AsyncBwSttClient(api_key, base_url)
        self._loop_thread: _EventLoopThread | None = None

    def _runner(self) -> _EventLoopThread:
        if self._loop_thread is None:
            self._loop_thread = _EventLoopThread()
            weakref.finalize(self, self._loop_thread.stop)
        return self._loop_thread

    def connect(
        self,
        encoding: str = "linear16",
        sample_rate: int = 16000,
        channels: int = 1,
        multichannel: bool = False,
        model: str | None = None,
        mode: str | None = None,
        redact_pii: bool = False,
        redact_pii_policies: Sequence[str] | None = None,
        redact_pii_sub: str | None = None,
        keywords: Sequence[str] | None = None,
        keepalive_interval: float | None = 25.0,
    ) -> Session:
        """Open a streaming session and wait for its SessionOpened event.

        ``mode`` selects when results are emitted: ``"instant"`` (the server
        default) emits Segments as soon as text is decoded; ``"demand"``
        holds results until ``finalize()`` or ``close_stream()``.
        """
        runner = self._runner()
        inner = runner.call(
            self._async.connect(
                encoding=encoding,
                sample_rate=sample_rate,
                channels=channels,
                multichannel=multichannel,
                model=model,
                mode=mode,
                redact_pii=redact_pii,
                redact_pii_policies=redact_pii_policies,
                redact_pii_sub=redact_pii_sub,
                keywords=keywords,
                keepalive_interval=keepalive_interval,
            )
        )
        return Session(inner, runner)

    def transcribe(
        self,
        audio: bytes | str | Path,
        *,
        encoding: str = "linear16",
        sample_rate: int = 16000,
        channels: int = 1,
        multichannel: bool = False,
        model: str | None = None,
        redact_pii: bool = False,
        redact_pii_policies: Sequence[str] | None = None,
        redact_pii_sub: str | None = None,
        keywords: Sequence[str] | None = None,
        raw: bool = False,
        timeout: float = 120.0,
    ) -> Transcription:
        """Transcribe a whole recording in one request.

        A str or Path is read as a PCM16 WAV file (its header supplies the
        sample rate and channel count) unless ``raw=True``; bytes are sent
        as-is with the stated parameters. Accepts up to about 5 minutes of
        audio.
        """
        api_key = _resolve_api_key(self.api_key)
        return _http.transcribe(
            self.base_url,
            api_key,
            audio,
            encoding=encoding,
            sample_rate=sample_rate,
            channels=channels,
            multichannel=multichannel,
            model=model,
            redact_pii=redact_pii,
            redact_pii_policies=redact_pii_policies,
            redact_pii_sub=redact_pii_sub,
            keywords=keywords,
            raw=raw,
            timeout=timeout,
        )


class Session:
    """Synchronous view of one live streaming session."""

    def __init__(self, inner: AsyncSession, runner: _EventLoopThread) -> None:
        self._inner = inner
        self._runner = runner

    @property
    def opened(self) -> SessionOpened:
        """The SessionOpened event received at connect time."""
        return self._inner.opened

    @property
    def is_open(self) -> bool:
        """True until the session ends, gracefully or not."""
        return self._inner.is_open

    def send_audio(self, data: bytes) -> None:
        """Send one binary audio frame, or one raw Opus packet."""
        self._runner.call(self._inner.send_audio(data))

    def finalize(self) -> None:
        """Flush buffered audio now; the session stays open, results follow as Segments."""
        self._runner.call(self._inner.finalize())

    def close_stream(self) -> SessionClosed:
        """End the session gracefully and return the terminal SessionClosed.

        Remaining events are drained; final Segments are dispatched to
        ``on_segment`` callbacks on the way.
        """
        return self._runner.call(self._inner.close_stream())

    def close(self) -> None:
        """Tear the connection down without waiting for SessionClosed."""
        self._runner.call(self._inner.close())

    def on_segment(self, callback: Callable[[Segment], object]) -> None:
        """Invoke ``callback`` for every Segment as events are consumed or drained."""
        self._inner.on_segment(callback)

    def events(self) -> Iterator[Event]:
        """Yield events until SessionClosed; raise ConnectionClosedError on failure."""
        iterator = self._inner.events()

        async def advance() -> Event:
            return await iterator.__anext__()

        while True:
            try:
                event = self._runner.call(advance())
            except StopAsyncIteration:
                return
            yield event

    def stream_chunks(self, chunks: Iterable[bytes]) -> Iterator[Segment]:
        """Send audio of arbitrary chunk sizes as exact 160 ms frames.

        Yields the Segments that arrive while sending; events other than
        Segments are not reported here, use :meth:`events` for full
        fidelity. Not supported for Opus.
        """
        params = self._inner._params
        chunker = FrameChunker(params.encoding, params.sample_rate, params.channels)
        return self._stream(chunker, chunks)

    def _stream(self, chunker: FrameChunker, chunks: Iterable[bytes]) -> Iterator[Segment]:
        for chunk in chunks:
            for frame in chunker.feed(chunk):
                self._runner.call(self._inner._send(frame))
            yield from self._runner.call(self._inner._poll_segments())
        tail = chunker.finish()
        if tail is not None:
            self._runner.call(self._inner._send(tail))
        yield from self._runner.call(self._inner._poll_segments())

    def stream_file(self, path: str | Path, raw: bool = False) -> Iterator[Segment]:
        """Stream a PCM16 WAV file, or any headerless file with ``raw=True``.

        The WAV header must match the session's encoding (linear16), sample
        rate, and channel count.
        """
        params = self._inner._params
        if raw:
            chunks = iter_raw_chunks(path)
        else:
            chunks = iter_wav_chunks(path, params.encoding, params.sample_rate, params.channels)
        return self.stream_chunks(chunks)

    def __enter__(self) -> Session:
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        tb: TracebackType | None,
    ) -> None:
        if exc_type is None and self.is_open:
            self.close_stream()
        else:
            self.close()
