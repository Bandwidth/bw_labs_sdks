"""In-process HTTP exchanges with deadlines and cancellable socket ownership."""

from __future__ import annotations

import asyncio
import contextvars
import http.client
import io
import socket
import ssl
import threading
import time
import urllib.error
import urllib.request
from collections.abc import Callable
from contextlib import suppress
from typing import Any, ParamSpec, TypeVar, cast
from urllib.parse import urlsplit

_P = ParamSpec("_P")
_T = TypeVar("_T")


class _Exchange:
    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.sock: socket.socket | None = None
        self.cancelled = False

    def attach(self, sock: socket.socket) -> None:
        with self.lock:
            if self.cancelled:
                sock.close()
                raise TimeoutError("request cancelled")
            self.sock = sock

    def cancel(self) -> None:
        with self.lock:
            self.cancelled = True
            if self.sock is not None:
                # Shutdown wakes a reader even while a buffered file owns the socket.
                with suppress(OSError):
                    self.sock.shutdown(socket.SHUT_RDWR)
                self.sock.close()

    def remaining(self, deadline: float) -> float:
        remaining = deadline - time.monotonic()
        if self.cancelled or remaining <= 0:
            raise TimeoutError("request deadline exceeded or cancelled")
        return remaining


_current: contextvars.ContextVar[_Exchange | None] = contextvars.ContextVar(
    "http_exchange", default=None
)


async def run_async(function: Callable[_P, _T], *args: _P.args, **kwargs: _P.kwargs) -> _T:
    """Close the active socket and join the request thread on cancellation."""
    state = _Exchange()
    token = _current.set(state)
    try:
        task = asyncio.create_task(asyncio.to_thread(function, *args, **kwargs))
    finally:
        _current.reset(token)
    try:
        return await asyncio.shield(task)
    except asyncio.CancelledError:
        state.cancel()
        while not task.done():
            try:
                await asyncio.shield(task)
            except asyncio.CancelledError:
                state.cancel()
            except Exception:
                break
        if not task.cancelled():
            task.exception()
        raise


class _DeadlineReader(io.RawIOBase):
    def __init__(self, sock: socket.socket, state: _Exchange, deadline: float) -> None:
        self.sock, self.state, self.deadline = sock, state, deadline

    def readable(self) -> bool:
        return True

    def readinto(self, buffer: Any) -> int:
        self.sock.settimeout(self.state.remaining(self.deadline))
        return self.sock.recv_into(buffer)


class _ResponseSocket:
    def __init__(self, sock: socket.socket, state: _Exchange, deadline: float) -> None:
        self.sock, self.state, self.deadline = sock, state, deadline

    def makefile(self, mode: str) -> io.BufferedReader:
        return io.BufferedReader(_DeadlineReader(self.sock, self.state, self.deadline))


def _connect(
    host: str, port: int, secure: bool, state: _Exchange, deadline: float
) -> socket.socket:
    addresses = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    failure: OSError | None = None
    for family, kind, protocol, _, address in addresses:
        sock = socket.socket(family, kind, protocol)
        try:
            state.attach(sock)
            sock.settimeout(state.remaining(deadline))
            sock.connect(address)
            if secure:
                context = ssl.create_default_context()
                sock.settimeout(state.remaining(deadline))
                sock = context.wrap_socket(
                    sock, server_hostname=host, do_handshake_on_connect=False
                )
                state.attach(sock)
                sock.settimeout(state.remaining(deadline))
                sock.do_handshake()
            return sock
        except OSError as exc:
            sock.close()
            failure = exc
            state.remaining(deadline)
    if failure is not None:
        raise failure
    raise OSError("no network address available")


def exchange(request: urllib.request.Request, timeout: float) -> tuple[int, bytes]:
    """Use one monotonic budget for connect, upload, headers and body.

    HTTPConnection never follows redirects. System DNS resolution is synchronous
    and cannot be interrupted by Python; its elapsed time consumes the budget.
    Environment proxy variables are not used by this direct HTTP transport.
    """
    deadline = time.monotonic() + timeout
    state = _current.get() or _Exchange()
    url = urlsplit(request.full_url)
    if url.scheme not in ("http", "https") or url.hostname is None:
        raise ValueError("API URL must use HTTP or HTTPS and include a host")
    port = url.port or (443 if url.scheme == "https" else 80)
    connection = http.client.HTTPConnection(url.hostname, port)
    response: http.client.HTTPResponse | None = None
    try:
        sock = _connect(url.hostname, port, url.scheme == "https", state, deadline)
        connection.sock = sock
        target = (url.path or "/") + ("?" + url.query if url.query else "")
        headers = dict(request.header_items())
        data = request.data or b""
        if not isinstance(data, bytes):
            raise TypeError("HTTP request data must be bytes")
        if request.data is not None:
            headers["Content-Length"] = str(len(data))
        sock.settimeout(state.remaining(deadline))
        connection.request(request.get_method(), target, headers=headers)
        for offset in range(0, len(data), 65536):
            sock.settimeout(state.remaining(deadline))
            connection.send(data[offset : offset + 65536])
        response = http.client.HTTPResponse(
            cast(socket.socket, _ResponseSocket(sock, state, deadline)),
            method=request.get_method(),
        )
        response.begin()
        state.remaining(deadline)
        status = response.status
        body = bytearray()
        if not 300 <= status < 400:
            while True:
                state.remaining(deadline)
                chunk = response.read1(65536)
                if not chunk:
                    break
                body.extend(chunk)
        state.remaining(deadline)
        if status >= 300:
            raise urllib.error.HTTPError(
                request.full_url, status, "HTTP error", response.headers, io.BytesIO(body)
            )
        return status, bytes(body)
    finally:
        connection.close()
        if response is not None:
            response.close()
        with state.lock:
            if state.sock is not None:
                state.sock.close()
            state.sock = None
