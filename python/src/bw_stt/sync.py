"""Synchronous client that drives the async client on a background event loop."""

from __future__ import annotations

import asyncio
import contextlib
import threading
import weakref
from collections.abc import Callable, Coroutine, Iterable, Iterator, Sequence
from pathlib import Path
from types import TracebackType
from typing import Any, Literal, TypeVar

from . import _http
from ._framing import FrameChunker, iter_raw_chunks, iter_wav_chunks
from ._wire import DEFAULT_BASE_URL
from .aio import AsyncBwSttClient, AsyncSession, _resolve_api_key
from .events import Event, Segment, SessionClosed, SessionOpened, Transcript, Transcription
from .transcriptions import TranscriptionsClient

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

    async def _shutdown(self) -> None:
        tasks = [task for task in asyncio.all_tasks() if task is not asyncio.current_task()]
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        await self._loop.shutdown_asyncgens()

    def stop(self) -> None:
        if self._loop.is_closed():
            return
        coro = self._shutdown()
        try:
            future = asyncio.run_coroutine_threadsafe(coro, self._loop)
        except RuntimeError:  # the loop closed in between
            coro.close()
            return
        with contextlib.suppress(Exception):
            future.result(timeout=5.0)
        try:
            self._loop.call_soon_threadsafe(self._loop.stop)
        except RuntimeError:
            return
        self._thread.join(timeout=5.0)
        if not self._thread.is_alive():
            self._loop.close()


class BwSttClient:
    """Client for the Bandwidth Labs speech-to-text API.

    The API key falls back to the ``BW_STT_API_KEY`` environment variable;
    ``base_url`` defaults to the public endpoint. The client can be used as
    a context manager; leaving the block calls :meth:`close`.
    """

    def __init__(self, api_key: str | None = None, base_url: str | None = None) -> None:
        self.api_key = api_key
        self.base_url = base_url or DEFAULT_BASE_URL
        self._async = AsyncBwSttClient(api_key, base_url)
        self.transcriptions = TranscriptionsClient(
            self.base_url, lambda: _resolve_api_key(self.api_key)
        )
        self._loop_thread: _EventLoopThread | None = None
        self._sessions: weakref.WeakSet[Session] = weakref.WeakSet()

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
        mode: Literal["instant", "demand"] | None = None,
        redact_pii: bool = False,
        redact_pii_sub: str | None = None,
        redact_pii_return: bool = False,
        keywords: Sequence[str] | None = None,
        keepalive_interval: float | None = 25.0,
        connect_timeout: float = 15.0,
    ) -> Session:
        """Open a streaming session and wait for its SessionOpened event.

        ``mode`` selects when results are emitted: ``"instant"`` (the server
        default) emits Segments as soon as text is decoded; ``"demand"``
        holds results until ``finalize()`` or ``close_stream()``.

        ``keepalive_interval`` of ``None`` or ``0`` disables the automatic
        KeepAlive timer. ``connect_timeout`` covers everything from opening
        the socket through receiving SessionOpened; on expiry the call
        raises :class:`ServiceUnavailableError`.
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
                redact_pii_sub=redact_pii_sub,
                redact_pii_return=redact_pii_return,
                keywords=keywords,
                keepalive_interval=keepalive_interval,
                connect_timeout=connect_timeout,
            )
        )
        session = Session(inner, runner, self)
        self._sessions.add(session)
        return session

    def transcribe(
        self,
        audio: bytes | str | Path,
        *,
        encoding: Literal["linear16"] = "linear16",
        sample_rate: int = 16000,
        channels: int = 1,
        multichannel: bool = False,
        model: str | None = None,
        redact_pii: bool = False,
        redact_pii_sub: str | None = None,
        redact_pii_return: bool = False,
        keywords: Sequence[str] | None = None,
        raw: bool = False,
        timeout: float = 120.0,
    ) -> Transcription:
        """Transcribe a whole recording in one request.

        A str or Path is uploaded as its PCM16 WAV container (its header
        supplies the sample rate and channel count) unless ``raw=True``.
        Raw bytes are sent as linear16 with the stated sample rate and
        channels. Accepts up to five minutes of decoded audio.
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
            redact_pii_sub=redact_pii_sub,
            redact_pii_return=redact_pii_return,
            keywords=keywords,
            raw=raw,
            timeout=timeout,
        )

    def close(self) -> None:
        """Close the client: abruptly close any open sessions and stop the loop thread."""
        if self._loop_thread is None:
            return
        for session in list(self._sessions):
            with contextlib.suppress(Exception):
                session.close()
        self._loop_thread.stop()
        self._loop_thread = None

    def __enter__(self) -> BwSttClient:
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        tb: TracebackType | None,
    ) -> None:
        self.close()


class Session:
    """Synchronous view of one live streaming session.

    ``on_segment`` and ``on_transcript`` callbacks run on the thread that
    consumes results (during iteration, ``events()``, or the ``close_stream()``
    drain), so a callback may call any Session method.
    """

    def __init__(self, inner: AsyncSession, runner: _EventLoopThread, client: BwSttClient) -> None:
        self._inner = inner
        self._runner = runner
        # the client owns the loop thread; this reference keeps it alive for
        # as long as any of its sessions exists
        self._client = client
        self._callbacks: list[Callable[[Segment], object]] = []
        self._transcript_callbacks: list[Callable[[Transcript], object]] = []

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
        """Flush buffered audio now without waiting for the server's results."""
        self._runner.call(self._inner.finalize())

    def finalize_transcript(self, timeout: float = 30.0) -> list[Transcript]:
        """Flush audio and wait for one demand-mode Transcript per channel.

        The returned list is ordered by channel. Use :meth:`finalize` when no
        response wait is desired.
        """
        transcripts = self._runner.call(self._inner.finalize_transcript(timeout))
        for transcript in transcripts:
            self._dispatch(transcript)
        return transcripts

    def close_stream(self) -> SessionClosed:
        """End the session gracefully and return the terminal SessionClosed.

        Remaining results are drained and dispatched to their callbacks on the
        way. Instant sessions drain Segments; demand sessions drain
        Transcripts. Every drained event stays available from :meth:`events`
        afterwards (yielded without a second callback dispatch).
        """
        replay = self._inner._replay
        drained_from = len(replay)
        try:
            return self._runner.call(self._inner.close_stream())
        finally:
            for event in list(replay)[drained_from:]:
                self._dispatch(event)

    def close(self) -> None:
        """Tear the connection down without waiting for SessionClosed."""
        self._runner.call(self._inner.close())

    def on_segment(self, callback: Callable[[Segment], object]) -> None:
        """Invoke ``callback`` for every Segment as events are consumed or drained."""
        self._callbacks.append(callback)

    def on_transcript(self, callback: Callable[[Transcript], object]) -> None:
        """Invoke ``callback`` for every demand-mode Transcript event."""
        self._transcript_callbacks.append(callback)

    def _dispatch(self, event: Event) -> None:
        if isinstance(event, Segment):
            for callback in tuple(self._callbacks):
                callback(event)
        elif isinstance(event, Transcript):
            for transcript_callback in tuple(self._transcript_callbacks):
                transcript_callback(event)

    def events(self) -> Iterator[Event]:
        """Yield events until SessionClosed; raise ConnectionClosedError on failure.

        Events drained by :meth:`close_stream` are yielded here afterwards,
        so the stream is complete no matter when it is consumed. SessionOpened
        is not part of the stream; it is available as :attr:`opened`.
        """
        replay = self._inner._replay
        while True:
            while replay:
                event = replay.popleft()
                yield event
                if isinstance(event, SessionClosed):
                    return
            event_or_eof = self._runner.call(self._inner._next_event())
            if event_or_eof is None:
                return
            self._dispatch(event_or_eof)
            yield event_or_eof
            if isinstance(event_or_eof, SessionClosed):
                return

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
            yield from self._poll_segments()
        tail = chunker.finish()
        if tail is not None:
            self._runner.call(self._inner._send(tail))
        yield from self._poll_segments()

    def _poll_segments(self) -> Iterator[Segment]:
        for segment in self._runner.call(self._inner._poll_segments()):
            self._dispatch(segment)
            yield segment

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
