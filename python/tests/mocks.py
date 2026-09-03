"""In-process mocks of the streaming and transcribe services."""

from __future__ import annotations

import asyncio
import contextlib
import json
import threading
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

from websockets.asyncio.server import ServerConnection, serve
from websockets.http11 import Request, Response

DOC_SEGMENTS: list[dict[str, Any]] = [
    {
        "type": "Segment",
        "channel": 0,
        "start": 0.00,
        "end": 0.20,
        "text": "i need",
        "words": [
            {"word": "i", "start": 0.00, "end": 0.12},
            {"word": "need", "start": 0.16, "end": 0.20},
        ],
    },
    {
        "type": "Segment",
        "channel": 0,
        "start": 0.24,
        "end": 0.44,
        "text": " a dr",
        "words": [
            {"word": "a", "start": 0.24, "end": 0.32},
            {"word": "dr", "start": 0.36, "end": 0.44},
        ],
    },
    {
        "type": "Segment",
        "channel": 0,
        "start": 0.48,
        "end": 0.72,
        "text": "y van",
        "words": [
            {"word": "y", "start": 0.48, "end": 0.56},
            {"word": "van", "start": 0.60, "end": 0.72},
        ],
    },
]


@dataclass
class Script:
    """What the mock streaming server should do for one test."""

    reject_status: int | None = None
    reject_headers: dict[str, str] = field(default_factory=dict)
    defer_opened: bool = False
    after_open: list[dict[str, Any]] = field(default_factory=list)
    close_after_open_events: bool = False
    segments_per_frame: dict[int, list[dict[str, Any]]] = field(default_factory=dict)
    on_finalize: list[dict[str, Any]] = field(default_factory=list)
    on_finalize_cycles: list[list[dict[str, Any]]] = field(default_factory=list)
    on_close: list[dict[str, Any]] = field(default_factory=lambda: [dict(s) for s in DOC_SEGMENTS])
    request_id: str = "req-1"
    channels: int = 1


@dataclass
class Recorder:
    """What the mock streaming server observed."""

    path: str | None = None
    headers: dict[str, str] = field(default_factory=dict)
    frames: list[bytes] = field(default_factory=list)
    keepalives: int = 0
    finalizes: int = 0
    audio_bytes: int = 0
    events_sent: int = 0


class MockSttServer:
    """A scripted WebSocket server speaking the public STT protocol."""

    def __init__(self, script: Script | None = None) -> None:
        self.script = script or Script()
        self.recorder = Recorder()
        self.port = 0
        self._loop: asyncio.AbstractEventLoop | None = None
        self._stop: asyncio.Event | None = None
        self._started = threading.Event()
        self._thread: threading.Thread | None = None

    @property
    def url(self) -> str:
        return f"ws://127.0.0.1:{self.port}/audio/v1/listen"

    def start(self) -> None:
        self._thread = threading.Thread(target=self._run, name="mock-stt", daemon=True)
        self._thread.start()
        assert self._started.wait(5.0), "mock server failed to start"

    def stop(self) -> None:
        if self._loop is not None and self._stop is not None:
            self._loop.call_soon_threadsafe(self._stop.set)
        if self._thread is not None:
            self._thread.join(timeout=5.0)

    def _run(self) -> None:
        asyncio.run(self._main())

    async def _main(self) -> None:
        self._loop = asyncio.get_running_loop()
        self._stop = asyncio.Event()
        async with serve(
            self._handle, "127.0.0.1", 0, process_request=self._process_request
        ) as server:
            self.port = server.sockets[0].getsockname()[1]
            self._started.set()
            await self._stop.wait()

    def _process_request(self, connection: ServerConnection, request: Request) -> Response | None:
        self.recorder.path = request.path
        self.recorder.headers = {key.lower(): value for key, value in request.headers.items()}
        if self.script.reject_status is not None:
            response = connection.respond(self.script.reject_status, "rejected\n")
            for key, value in self.script.reject_headers.items():
                response.headers[key] = value
            return response
        return None

    async def _handle(self, connection: ServerConnection) -> None:
        script, recorder = self.script, self.recorder
        if script.defer_opened:
            with contextlib.suppress(Exception):
                async for _message in connection:
                    pass
            return
        await self._send_json(
            connection,
            {
                "type": "SessionOpened",
                "request_id": script.request_id,
                "model_info": {"name": "bw-streaming-en", "version": "current"},
                "channels": script.channels,
                "sample_rate": 16000,
                "encoding": "linear16",
            },
        )
        for event in script.after_open:
            await self._send_json(connection, event)
        if script.close_after_open_events:
            await connection.close()
            return
        async for message in connection:
            if isinstance(message, bytes):
                recorder.frames.append(message)
                recorder.audio_bytes += len(message)
                for event in script.segments_per_frame.get(len(recorder.frames), []):
                    await self._send_json(connection, event)
                    recorder.events_sent += 1
                continue
            control = json.loads(message)
            control_type = control.get("type")
            if control_type == "KeepAlive":
                recorder.keepalives += 1
            elif control_type == "Finalize":
                recorder.finalizes += 1
                events = script.on_finalize
                cycle_index = recorder.finalizes - 1
                if cycle_index < len(script.on_finalize_cycles):
                    events = script.on_finalize_cycles[cycle_index]
                for event in events:
                    await self._send_json(connection, event)
            elif control_type == "CloseStream":
                for event in script.on_close:
                    await self._send_json(connection, event)
                # the mock always describes itself as 16 kHz mono linear16
                await self._send_json(
                    connection,
                    {
                        "type": "SessionClosed",
                        "request_id": script.request_id,
                        "audio_duration_seconds": round(recorder.audio_bytes / 32000.0, 4),
                        "session_duration_seconds": 1.0,
                    },
                )
                break
        await connection.close()

    @staticmethod
    async def _send_json(connection: ServerConnection, payload: dict[str, Any]) -> None:
        await connection.send(json.dumps(payload))


DEFAULT_TRANSCRIPTION: dict[str, Any] = {
    "request_id": "req-t",
    "text": "i need a dry van",
    "words": [
        {"word": "i", "start": 0.00, "end": 0.12},
        {"word": "need", "start": 0.16, "end": 0.20},
        {"word": "a", "start": 0.24, "end": 0.32},
        {"word": "dry", "start": 0.36, "end": 0.56},
        {"word": "van", "start": 0.60, "end": 0.72},
    ],
    "segments": [{"start": 0.0, "end": 0.72, "text": "i need a dry van"}],
    "audio_duration_seconds": 2.5,
    "model_info": {"name": "bw-streaming-en", "version": "current"},
}


@dataclass
class HttpScript:
    """What the mock transcribe server should return."""

    status: int = 200
    body: dict[str, Any] | None = None
    raw_body: bytes | None = None
    headers: dict[str, str] = field(default_factory=dict)


@dataclass
class HttpRecorder:
    """What the mock transcribe server observed."""

    method: str | None = None
    path: str | None = None
    headers: dict[str, str] = field(default_factory=dict)
    body: bytes = b""


class MockTranscribeServer:
    """A scripted HTTP server for the offline transcribe route."""

    def __init__(self, script: HttpScript | None = None) -> None:
        self.script = script or HttpScript()
        self.recorder = HttpRecorder()
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:
                outer.recorder.method = "POST"
                outer.recorder.path = self.path
                outer.recorder.headers = {key.lower(): value for key, value in self.headers.items()}
                length = int(self.headers.get("Content-Length", "0"))
                outer.recorder.body = self.rfile.read(length)
                script = outer.script
                if script.raw_body is not None:
                    payload = script.raw_body
                else:
                    payload = json.dumps(script.body or DEFAULT_TRANSCRIPTION).encode()
                self.send_response(script.status)
                for key, value in script.headers.items():
                    self.send_header(key, value)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

            def log_message(self, format: str, *args: Any) -> None:
                pass

        self._server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.port = self._server.server_address[1]
        self._thread = threading.Thread(
            target=self._server.serve_forever, name="mock-transcribe", daemon=True
        )
        self._thread.start()

    @property
    def base_url(self) -> str:
        """A ws:// base URL from which the client derives the http transcribe URL."""
        return f"ws://127.0.0.1:{self.port}/audio/v1/listen"

    def stop(self) -> None:
        with contextlib.suppress(Exception):
            self._server.shutdown()
            self._server.server_close()
        self._thread.join(timeout=5.0)


class MockTranscriptionsServer:
    """A scripted HTTP server for the asynchronous transcription routes."""

    def __init__(self, scripts: list[HttpScript]) -> None:
        self.scripts = list(scripts)
        self.requests: list[HttpRecorder] = []
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def _handle(self) -> None:
                length = int(self.headers.get("Content-Length", "0"))
                recorder = HttpRecorder(
                    method=self.command,
                    path=self.path,
                    headers={key.lower(): value for key, value in self.headers.items()},
                    body=self.rfile.read(length),
                )
                outer.requests.append(recorder)
                script = outer.scripts.pop(0) if outer.scripts else HttpScript()
                if script.raw_body is not None:
                    payload = script.raw_body
                elif script.body is not None:
                    payload = json.dumps(script.body).encode()
                else:
                    payload = b""
                self.send_response(script.status)
                for key, value in script.headers.items():
                    self.send_header(key, value)
                if payload:
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                if payload:
                    self.wfile.write(payload)

            def do_DELETE(self) -> None:
                self._handle()

            def do_GET(self) -> None:
                self._handle()

            def do_POST(self) -> None:
                self._handle()

            def log_message(self, format: str, *args: Any) -> None:
                pass

        self._server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.port = self._server.server_address[1]
        self._thread = threading.Thread(
            target=self._server.serve_forever, name="mock-transcriptions", daemon=True
        )
        self._thread.start()

    @property
    def base_url(self) -> str:
        return f"ws://127.0.0.1:{self.port}/audio/v1/listen"

    def stop(self) -> None:
        with contextlib.suppress(Exception):
            self._server.shutdown()
            self._server.server_close()
        self._thread.join(timeout=5.0)
