# Changelog

## Next

- Added stereo multichannel parsing for offline transcription.
- Added synchronous and asynchronous transcription job submission, polling, and
  deletion with callback options and typed job errors.
- Updated callback credential transport to use request headers for uploads and
  the JSON callback object for URL submissions. Added `job_submission_busy`
  handling with `retry_after` on `JobLimitError`.

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
