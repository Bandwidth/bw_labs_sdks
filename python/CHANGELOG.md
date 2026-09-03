# Changelog

## 0.2.0

- Added synchronous and asynchronous transcription jobs with `submit`,
  `submit_url`, `get`, `wait`, and `delete`.
- Added typed multichannel transcription results that match the service's
  per-channel response shape.
- Added callback credential transport through upload request headers or the
  URL submission JSON callback object, plus `job_submission_busy` handling with
  `retry_after` on `JobLimitError`.
- Added `TranscriptionTimeoutError` for `wait()` deadlines, with a 600 second
  default timeout and a 2 second polling interval.
- Added RIFF/WAVE sniffing for byte uploads when `raw=False`, so WAV bytes keep
  their container and omit raw-only parameters.

## 0.1.0

Initial release.

- Streaming client for the Bandwidth Labs speech-to-text WebSocket API,
  synchronous (`BwSttClient`) and asynchronous (`AsyncBwSttClient`).
- Automatic 160 ms framing (`stream_chunks`, `stream_file`), frame
  validation, and KeepAlive during send-side quiet.
- Instant and demand result modes, PII redaction, and keyword boosting
  options.
- Offline `transcribe()` for whole recordings.
- `TranscriptAssembler` and `WordAssembler` for verbatim transcripts and
  live word display.
- Typed events, typed errors, and full test coverage against an in-process
  mock server.
