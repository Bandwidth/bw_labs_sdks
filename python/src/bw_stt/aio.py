"""Asynchronous client built on the websockets package."""

from __future__ import annotations

import asyncio
import contextlib
import inspect
import os
import time
from collections import deque
from collections.abc import AsyncIterable, AsyncIterator, Callable, Iterable, Sequence
from pathlib import Path
from types import TracebackType
from typing import Any, Literal

from . import _http
from ._framing import FrameChunker, iter_raw_chunks, iter_wav_chunks, validate_frame
from ._wire import (
    API_KEY_ENV,
    API_KEY_HEADER,
    CLOSE_STREAM_JSON,
    DEFAULT_BASE_URL,
    FINALIZE_JSON,
    KEEP_ALIVE_JSON,
    SessionParams,
    build_ws_url,
)
from .errors import (
    AuthenticationError,
    BwSttError,
    ConnectionClosedError,
    ProtocolError,
    RateLimitError,
    ServiceUnavailableError,
)
from .events import (
    ErrorEvent,
    Event,
    Segment,
    SessionClosed,
    SessionOpened,
    Transcription,
    parse_event,
)

__all__ = ["AsyncBwSttClient", "AsyncSession"]

SegmentCallback = Callable[[Segment], object]

_EOF = object()


def _resolve_api_key(explicit: str | None) -> str:
    if explicit is not None:
        if not explicit:
            raise AuthenticationError("api_key must not be empty")
        return explicit
    api_key = os.environ.get(API_KEY_ENV)
    if not api_key:
        raise AuthenticationError(f"no API key: pass api_key or set {API_KEY_ENV}")
    return api_key


def _status_and_headers(exc: Exception) -> tuple[int | None, Any]:
    response = getattr(exc, "response", None)
    if response is not None:
        status = getattr(response, "status_code", None)
        if isinstance(status, int):
            return status, getattr(response, "headers", None)
    status = getattr(exc, "status_code", None)
    if isinstance(status, int):
        return status, getattr(exc, "headers", None)
    return None, None


def _map_rejected_upgrade(exc: Exception) -> BwSttError | None:
    status, headers = _status_and_headers(exc)
    if status in (401, 403):
        return AuthenticationError(f"API key rejected (HTTP {status})")
    if status == 429:
        value = headers.get("Retry-After") if headers is not None else None
        return RateLimitError("rate limited (HTTP 429)", retry_after=_http.parse_retry_after(value))
    if status is not None and status >= 500:
        return ServiceUnavailableError(f"service unavailable (HTTP {status})")
    return None


async def _open_websocket(url: str, api_key: str) -> Any:
    from websockets.asyncio.client import connect

    headers = {API_KEY_HEADER: api_key}
    signature_error: TypeError | None = None
    # websockets renamed the handshake-header argument in version 14
    for header_arg in ("additional_headers", "extra_headers"):
        # the caller's connect_timeout governs the whole open, not websockets' own
        kwargs: dict[str, Any] = {header_arg: headers, "open_timeout": None}
        try:
            return await connect(url, **kwargs)
        except TypeError as exc:
            signature_error = exc
            continue
        except Exception as exc:
            mapped = _map_rejected_upgrade(exc)
            if mapped is None:
                raise
            raise mapped from exc
    raise BwSttError(f"unsupported websockets version: {signature_error}")


async def _as_async_iter(chunks: Iterable[bytes] | AsyncIterable[bytes]) -> AsyncIterator[bytes]:
    if isinstance(chunks, AsyncIterable):
        async for chunk in chunks:
            yield chunk
    else:
        for chunk in chunks:
            yield chunk


class AsyncBwSttClient:
    """Asynchronous client for the Bandwidth Labs speech-to-text API.

    The API key falls back to the ``BW_STT_API_KEY`` environment variable;
    ``base_url`` defaults to the public endpoint.
    """

    def __init__(self, api_key: str | None = None, base_url: str | None = None) -> None:
        self.api_key = api_key
        self.base_url = base_url or DEFAULT_BASE_URL

    async def connect(
        self,
        encoding: str = "linear16",
        sample_rate: int = 16000,
        channels: int = 1,
        multichannel: bool = False,
        model: str | None = None,
        mode: Literal["instant", "demand"] | None = None,
        redact_pii: bool = False,
        redact_pii_policies: Sequence[str] | None = None,
        redact_pii_sub: str | None = None,
        keywords: Sequence[str] | None = None,
        keepalive_interval: float | None = 25.0,
        connect_timeout: float = 15.0,
    ) -> AsyncSession:
        """Open a streaming session and wait for its SessionOpened event.

        ``mode`` selects when results are emitted: ``"instant"`` (the server
        default) emits Segments as soon as text is decoded; ``"demand"``
        holds results until ``finalize()`` or ``close_stream()``.

        ``keepalive_interval`` of ``None`` or ``0`` disables the automatic
        KeepAlive timer. ``connect_timeout`` covers everything from opening
        the socket through receiving SessionOpened; on expiry the call
        raises :class:`ServiceUnavailableError`.
        """
        api_key = _resolve_api_key(self.api_key)
        if keepalive_interval is not None and keepalive_interval < 0:
            raise ValueError("keepalive_interval must not be negative")
        if connect_timeout <= 0:
            raise ValueError("connect_timeout must be positive")
        params = SessionParams(
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
        )
        try:
            return await asyncio.wait_for(
                self._open_session(params, api_key, keepalive_interval or None),
                connect_timeout,
            )
        except asyncio.TimeoutError:
            raise ServiceUnavailableError(f"connect timed out after {connect_timeout:g}s") from None

    async def _open_session(
        self, params: SessionParams, api_key: str, keepalive_interval: float | None
    ) -> AsyncSession:
        ws = await _open_websocket(build_ws_url(self.base_url, params), api_key)
        session = AsyncSession(ws, params, keepalive_interval)
        try:
            await session._handshake()
        except BaseException:
            await session.close()
            raise
        return session

    async def transcribe(
        self,
        audio: bytes | str | Path,
        *,
        encoding: Literal["linear16"] = "linear16",
        sample_rate: int = 16000,
        channels: int = 1,
        model: str | None = None,
        redact_pii: bool = False,
        redact_pii_policies: Sequence[str] | None = None,
        redact_pii_sub: str | None = None,
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
        return await asyncio.to_thread(
            _http.transcribe,
            self.base_url,
            api_key,
            audio,
            encoding=encoding,
            sample_rate=sample_rate,
            channels=channels,
            model=model,
            redact_pii=redact_pii,
            redact_pii_policies=redact_pii_policies,
            redact_pii_sub=redact_pii_sub,
            keywords=keywords,
            raw=raw,
            timeout=timeout,
        )


class AsyncSession:
    """One live streaming session; create it with :meth:`AsyncBwSttClient.connect`."""

    def __init__(self, ws: Any, params: SessionParams, keepalive_interval: float | None) -> None:
        self._ws = ws
        self._params = params
        self._keepalive_interval = keepalive_interval
        self._queue: asyncio.Queue[object] = asyncio.Queue()
        self._replay: deque[Event] = deque()
        self._send_lock = asyncio.Lock()
        self._callbacks: list[SegmentCallback] = []
        self._last_send = time.monotonic()
        self._last_error: ErrorEvent | None = None
        self._session_closed: SessionClosed | None = None
        self._close_sent = False
        self._closed = False
        self._reader_task: asyncio.Task[None] | None = None
        self._keepalive_task: asyncio.Task[None] | None = None
        self.opened: SessionOpened

    @property
    def is_open(self) -> bool:
        """True until the session ends, gracefully or not."""
        return not self._closed and self._session_closed is None

    async def _handshake(self) -> None:
        try:
            payload = await self._ws.recv()
        except Exception as exc:
            raise ConnectionClosedError("connection closed before SessionOpened") from exc
        event = parse_event(payload)
        if isinstance(event, ErrorEvent):
            raise ConnectionClosedError("session rejected", error_event=event)
        if not isinstance(event, SessionOpened):
            raise ProtocolError(f"expected SessionOpened, received {type(event).__name__}")
        self.opened = event
        self._last_send = time.monotonic()
        self._reader_task = asyncio.create_task(self._read_loop())
        if self._keepalive_interval is not None:
            self._keepalive_task = asyncio.create_task(self._keepalive_loop())

    async def _read_loop(self) -> None:
        try:
            while True:
                payload = await self._ws.recv()
                event = parse_event(payload)
                if isinstance(event, ErrorEvent):
                    self._last_error = event
                if isinstance(event, SessionClosed):
                    self._session_closed = event
                    self._queue.put_nowait(event)
                    self._queue.put_nowait(_EOF)
                    return
                self._queue.put_nowait(event)
        except asyncio.CancelledError:
            raise
        except ProtocolError as exc:
            self._queue.put_nowait(exc)
        except Exception:
            self._queue.put_nowait(
                ConnectionClosedError(
                    "connection closed unexpectedly", error_event=self._last_error
                )
            )

    async def _deliver(self, item: object) -> Event | None:
        """Dispatch one dequeued item; None means the session is over."""
        if item is _EOF:
            self._queue.put_nowait(_EOF)
            return None
        if isinstance(item, BwSttError):
            self._queue.put_nowait(item)
            await self.close()
            raise item
        event: Event = item  # type: ignore[assignment]
        if isinstance(event, Segment):
            for callback in tuple(self._callbacks):
                result = callback(event)
                if inspect.isawaitable(result):
                    await result
        return event

    async def _next_event(self) -> Event | None:
        item = await self._queue.get()
        return await self._deliver(item)

    async def _poll_segments(self) -> list[Segment]:
        segments: list[Segment] = []
        while True:
            try:
                item = self._queue.get_nowait()
            except asyncio.QueueEmpty:
                return segments
            event = await self._deliver(item)
            if event is None:
                return segments
            if isinstance(event, Segment):
                segments.append(event)

    async def _send(self, payload: str | bytes) -> None:
        if self._closed:
            raise ConnectionClosedError("session is closed", error_event=self._last_error)
        async with self._send_lock:
            try:
                await self._ws.send(payload)
            except Exception as exc:
                raise ConnectionClosedError(
                    "connection closed while sending", error_event=self._last_error
                ) from exc
        self._last_send = time.monotonic()

    async def send_audio(self, data: bytes) -> None:
        """Send one binary audio frame, or one raw Opus packet."""
        validate_frame(data, self._params.encoding, self._params.sample_rate, self._params.channels)
        await self._send(data)

    async def finalize(self) -> None:
        """Flush buffered audio now; the session stays open, results follow as Segments."""
        await self._send(FINALIZE_JSON)

    async def close_stream(self) -> SessionClosed:
        """End the session gracefully and return the terminal SessionClosed.

        Remaining events are drained: final Segments are dispatched to
        ``on_segment`` callbacks on the way, and every drained event stays
        available from :meth:`events` afterwards (yielded without a second
        callback dispatch).
        """
        if self._session_closed is not None:
            await self.close()
            return self._session_closed
        try:
            if not self._close_sent:
                self._close_sent = True
                await self._send(CLOSE_STREAM_JSON)
            while True:
                event = await self._next_event()
                if event is None:
                    break
                self._replay.append(event)
                if isinstance(event, SessionClosed):
                    break
        finally:
            await self.close()
        closed = self._session_closed
        if closed is None:
            raise ConnectionClosedError(
                "connection closed before SessionClosed", error_event=self._last_error
            )
        return closed

    async def close(self) -> None:
        """Tear the connection down without waiting for SessionClosed."""
        if self._closed:
            return
        self._closed = True
        current = asyncio.current_task()
        tasks = [
            task
            for task in (self._keepalive_task, self._reader_task)
            if task is not None and task is not current
        ]
        for task in tasks:
            task.cancel()
        with contextlib.suppress(Exception):
            await self._ws.close()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        self._queue.put_nowait(_EOF)

    def on_segment(self, callback: SegmentCallback) -> None:
        """Invoke ``callback`` for every Segment as events are consumed or drained."""
        self._callbacks.append(callback)

    async def events(self) -> AsyncIterator[Event]:
        """Yield events until SessionClosed; raise ConnectionClosedError on failure.

        Events drained by :meth:`close_stream` are yielded here afterwards,
        so the stream is complete no matter when it is consumed. SessionOpened
        is not part of the stream; it is available as :attr:`opened`.
        """
        while True:
            while self._replay:
                replayed = self._replay.popleft()
                yield replayed
                if isinstance(replayed, SessionClosed):
                    return
            event = await self._next_event()
            if event is None:
                return
            yield event
            if isinstance(event, SessionClosed):
                return

    def stream_chunks(
        self, chunks: Iterable[bytes] | AsyncIterable[bytes]
    ) -> AsyncIterator[Segment]:
        """Send audio of arbitrary chunk sizes as exact 160 ms frames.

        Yields the Segments that arrive while sending; events other than
        Segments are not reported here, use :meth:`events` for full
        fidelity. Not supported for Opus.
        """
        chunker = FrameChunker(
            self._params.encoding, self._params.sample_rate, self._params.channels
        )
        return self._stream(chunker, chunks)

    async def _stream(
        self, chunker: FrameChunker, chunks: Iterable[bytes] | AsyncIterable[bytes]
    ) -> AsyncIterator[Segment]:
        async for chunk in _as_async_iter(chunks):
            for frame in chunker.feed(chunk):
                await self._send(frame)
            for segment in await self._poll_segments():
                yield segment
        tail = chunker.finish()
        if tail is not None:
            await self._send(tail)
        for segment in await self._poll_segments():
            yield segment

    def stream_file(self, path: str | Path, raw: bool = False) -> AsyncIterator[Segment]:
        """Stream a PCM16 WAV file, or any headerless file with ``raw=True``.

        The WAV header must match the session's encoding (linear16), sample
        rate, and channel count.
        """
        if raw:
            chunks = iter_raw_chunks(path)
        else:
            chunks = iter_wav_chunks(
                path, self._params.encoding, self._params.sample_rate, self._params.channels
            )
        return self.stream_chunks(chunks)

    async def _keepalive_loop(self) -> None:
        interval = self._keepalive_interval
        if interval is None:
            return
        try:
            while not self._closed and not self._close_sent:
                deadline = self._last_send + interval
                if time.monotonic() >= deadline:
                    await self._send(KEEP_ALIVE_JSON)
                    deadline = self._last_send + interval
                await asyncio.sleep(max(deadline - time.monotonic(), 0.0))
        except asyncio.CancelledError:
            raise
        except ConnectionClosedError:
            return

    async def __aenter__(self) -> AsyncSession:
        return self

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        tb: TracebackType | None,
    ) -> None:
        if exc_type is None and self.is_open:
            await self.close_stream()
        else:
            await self.close()
