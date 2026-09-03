# Changelog

## 0.2.0

- Added asynchronous transcription jobs with `submit` for bytes, `submit` with
  `audioUrl` for URL sources, `get`, `wait`, and `delete`.
- Added typed multichannel transcription results that match the service's
  per-channel response shape.
- Added callback credential transport through upload request headers or the
  URL submission JSON callback object, plus `job_submission_busy` handling with
  `retryAfterSeconds` on `JobLimitError`.
- Added `TranscriptionTimeoutError` for `wait()` deadlines, with a 600 second
  default timeout, a 2 second polling interval, and abort-aware polling.
- Added WAV byte uploads with `raw: false`, preserving the container and
  omitting raw-only parameters.

## 0.1.0

Initial release.

- Streaming sessions over WebSocket: `connect`, `sendAudio`, `streamChunks`, `streamFile`, `events`, `on`/`off`, `finalize`, `closeStream`, `disconnect`.
- Instant and demand result modes.
- Offline transcription: `transcribe` and `transcribeFile` (up to 5 minutes of audio).
- PII redaction and keyword boosting options on both surfaces.
- Automatic KeepAlive during send-side quiet.
- Deadlines and cancellation: `connectTimeoutMs` on connect (default 15 s), whole-request `timeoutMs` (default 120 s) and an optional `AbortSignal` on transcribe.
- WAVE_FORMAT_EXTENSIBLE PCM WAV support; send-side backpressure while streaming files and chunks.
- `TranscriptAssembler` and `WordAssembler` for verbatim transcripts and live word display.
- Typed events with camelCase fields and raw payloads; typed connection errors.
- Node 18+ and browser support; dual ESM and CJS builds.
