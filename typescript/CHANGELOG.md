# Changelog

## Next

- Added stereo multichannel parsing for offline transcription.
- Added transcription job submission, polling, deletion, callback options, and
  typed job errors.

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
