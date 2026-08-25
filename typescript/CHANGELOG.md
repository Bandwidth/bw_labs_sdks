# Changelog

## 0.1.0

Initial release.

- Streaming sessions over WebSocket: `connect`, `sendAudio`, `streamChunks`, `streamFile`, `events`, `on`/`off`, `finalize`, `closeStream`, `disconnect`.
- Instant and demand result modes.
- Offline transcription: `transcribe` and `transcribeFile` (up to 5 minutes of audio).
- PII redaction and keyword boosting options on both surfaces.
- Automatic KeepAlive during send-side quiet.
- `TranscriptAssembler` and `WordAssembler` for verbatim transcripts and live word display.
- Typed events with camelCase fields and raw payloads; typed connection errors.
- Node 18+ and browser support; dual ESM and CJS builds.
