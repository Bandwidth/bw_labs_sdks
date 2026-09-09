from __future__ import annotations

import asyncio
import json
import socket
import ssl
import subprocess
import threading
import time
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from bw_stt import (
    AsyncBwSttClient,
    BwSttClient,
    ProtocolError,
    ServiceUnavailableError,
    TranscriptionTimeoutError,
    _transport,
)

from .mocks import DEFAULT_TRANSCRIPTION


@contextmanager
def server(handler, context=None):
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    if context is not None:
        httpd.socket = context.wrap_socket(httpd.socket, server_side=True)
    thread = threading.Thread(target=lambda: httpd.serve_forever(poll_interval=0.01), daemon=True)
    thread.start()
    try:
        yield f"{'https' if context else 'http'}://127.0.0.1:{httpd.server_port}"
    finally:
        httpd.shutdown()
        httpd.server_close()
        thread.join()


@pytest.fixture
def tls(tmp_path, monkeypatch):
    cert, key = tmp_path / "cert.pem", tmp_path / "key.pem"
    subprocess.run(
        [
            "openssl",
            "req",
            "-x509",
            "-newkey",
            "rsa:2048",
            "-nodes",
            "-days",
            "1",
            "-subj",
            "/CN=localhost",
            "-addext",
            "subjectAltName=IP:127.0.0.1",
            "-keyout",
            str(key),
            "-out",
            str(cert),
        ],
        check=True,
        capture_output=True,
    )
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(cert, key)
    trusted = ssl.create_default_context(cafile=str(cert))
    monkeypatch.setattr(_transport.ssl, "create_default_context", lambda: trusted)
    return context


@pytest.mark.parametrize("method", ["get", "submit", "delete", "transcribe"])
@pytest.mark.parametrize("destination", ["cross-origin", "same-origin", "downgrade"])
@pytest.mark.parametrize("status", [301, 302, 303, 307, 308])
def test_redirect_never_reaches_destination(method, destination, status, tls):
    received = []
    source_requests = []
    location = ""

    class Destination(BaseHTTPRequestHandler):
        def do_GET(self):
            received.append(dict(self.headers))
            self.send_response(200)
            self.end_headers()

        do_POST = do_DELETE = do_GET

        def log_message(self, *args):
            pass

    class Source(Destination):
        def do_GET(self):
            if self.path == "/redirected":
                return super().do_GET()
            source_requests.append(dict(self.headers))
            self.send_response(status)
            self.send_header("Location", location)
            self.end_headers()

        do_POST = do_DELETE = do_GET

    with (
        server(Destination) as target,
        server(Source, tls if destination == "downgrade" else None) as source,
    ):
        location = (source if destination == "same-origin" else target) + "/redirected"
        client = BwSttClient(api_key="synthetic-key", base_url=source)
        with pytest.raises(ProtocolError) as error:
            if method == "transcribe":
                client.transcribe(b"\0\0")
            elif method == "submit":
                client.transcriptions.submit(b"\0\0")
            else:
                getattr(client.transcriptions, method)("job-1")
        assert error.value.status == status
        assert str(status) in str(error.value)
        assert len(source_requests) == 1
        assert {k.lower(): v for k, v in source_requests[0].items()}[
            "user-agent"
        ] == "bw-stt-python/0.2.0"
        assert received == []


@contextmanager
def slow_response(headers=False):
    started = threading.Event()
    disconnected = threading.Event()
    payload = json.dumps(
        {
            "id": "job-1",
            "status": "completed",
            "progress": 1,
            "created_at": "2026-09-03T12:00:00Z",
            "updated_at": "2026-09-03T12:00:01Z",
            "result": DEFAULT_TRANSCRIPTION,
        }
    ).encode()

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            started.set()
            try:
                if headers:
                    for byte in b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n":
                        self.connection.sendall(bytes([byte]))
                        time.sleep(0.02)
                else:
                    self.send_response(200)
                    self.send_header("Content-Length", str(len(payload)))
                    self.end_headers()
                for byte in payload:
                    self.wfile.write(bytes([byte]))
                    self.wfile.flush()
                    time.sleep(0.02)
            except OSError:
                disconnected.set()

        def log_message(self, *args):
            pass

    with server(Handler) as url:
        yield url, started, disconnected


@pytest.mark.parametrize("headers", [False, True])
def test_wait_deadline_bounds_dripping_response(headers):
    with slow_response(headers) as (url, _, disconnected):
        client = BwSttClient(api_key="synthetic-key", base_url=url)
        start = time.monotonic()
        with pytest.raises(TranscriptionTimeoutError):
            client.transcriptions.wait("job-1", timeout=0.1)
        assert 0.08 <= time.monotonic() - start < 0.25
        assert disconnected.wait(0.25)


@pytest.mark.asyncio
async def test_async_wait_deadline():
    with slow_response() as (url, _, disconnected):
        client = AsyncBwSttClient(api_key="synthetic-key", base_url=url)
        start = time.monotonic()
        with pytest.raises(TranscriptionTimeoutError):
            await client.transcriptions.wait("job-1", timeout=0.1)
        assert time.monotonic() - start < 0.25
        assert await asyncio.to_thread(disconnected.wait, 0.25)


@pytest.mark.asyncio
async def test_cancellation_closes_transport_and_joins_worker(monkeypatch):
    finished = threading.Event()
    original = _transport.exchange

    def tracked(*args, **kwargs):
        try:
            return original(*args, **kwargs)
        finally:
            finished.set()

    monkeypatch.setattr("bw_stt._http.exchange", tracked)
    with slow_response() as (url, started, disconnected):
        client = AsyncBwSttClient(api_key="synthetic-key", base_url=url)
        task = asyncio.create_task(client.transcriptions.get("job-1"))
        assert await asyncio.to_thread(started.wait, 1)
        start = time.monotonic()
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert time.monotonic() - start < 0.25
        assert finished.is_set()
        assert await asyncio.to_thread(disconnected.wait, 0.25)


@pytest.mark.asyncio
async def test_streaming_refused_connection_is_service_error():
    with socket.socket() as bound:
        bound.bind(("127.0.0.1", 0))
        port = bound.getsockname()[1]
        client = AsyncBwSttClient(api_key="synthetic-key", base_url=f"ws://127.0.0.1:{port}")
        with pytest.raises(ServiceUnavailableError) as error:
            await client.connect()
        assert isinstance(error.value.__cause__, OSError)
        assert "synthetic-key" not in str(error.value.__cause__)
        assert "127.0.0.1" not in str(error.value.__cause__)
