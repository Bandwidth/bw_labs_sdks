# Bandwidth Labs SDKs

Official client SDKs for Bandwidth Labs services.

| SDK | Package | Directory |
|---|---|---|
| Python | `bw-stt` | [`python/`](python/) |
| TypeScript / Node | `@bandwidth/bw-stt` | [`typescript/`](typescript/) |

Both SDKs cover the Speech to Text API: streaming transcription over the
`/audio/v1/listen` WebSocket in instant and demand modes, whole-file
transcription over `POST /audio/v1/transcribe`, PII redaction, and keyword
boosting. Each package ships typed events, word-level timestamps, and
transcript assembly utilities, with a runnable example under its `examples/`
directory.

Create an API key from your dashboard at
[labs.bandwidth.com](https://labs.bandwidth.com), set it as
`BW_STT_API_KEY`, and follow the quickstart in the SDK's README.
