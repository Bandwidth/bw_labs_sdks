# bw-stt

Python SDK for the Bandwidth Labs speech-to-text API. Stream audio over a
WebSocket and receive final transcript segments in real time, or send a whole
recording for whole-file transcription.

## Install

```bash
pip install bw-stt
```

Requires Python 3.10 or later. Set your API key once:

```bash
export BW_STT_API_KEY=bwa_key_...
```

## Quickstart

Synchronous:

```python
from bw_stt import BwSttClient, TranscriptAssembler

client = BwSttClient()
transcript = TranscriptAssembler()
with client.connect(encoding="linear16", sample_rate=16000) as session:
    session.on_segment(transcript.push)
    for _segment in session.stream_file("call.wav"):
        print("\r" + transcript.text, end="", flush=True)
    closed = session.close_stream()
print("\r" + transcript.text)
print(f"audio seconds: {closed.audio_duration_seconds:.2f}")
```

Asynchronous:

```python
from bw_stt import AsyncBwSttClient, TranscriptAssembler

client = AsyncBwSttClient()
transcript = TranscriptAssembler()
async with await client.connect() as session:
    session.on_segment(transcript.push)
    async for _segment in session.stream_file("call.wav"):
        print("\r" + transcript.text, end="", flush=True)
    closed = await session.close_stream()
print("\r" + transcript.text)
print(f"audio seconds: {closed.audio_duration_seconds:.2f}")
```

Every segment is final. Text concatenates verbatim across segments: a segment
whose text starts with a space begins a new word, one without a leading space
continues the previous word. `TranscriptAssembler` applies that rule for you.

Iteration over `stream_file()` yields only the segments that arrive while
audio is still being sent; the server flushes the rest in response to
`close_stream()`. The drain dispatches those final segments to `on_segment`
callbacks and keeps every drained event available from `events()` afterwards,
so assemble the transcript through a callback (as above) or by consuming
`events()`, not from the send-side iteration alone.

## Listen modes and Transcribe

Instant and demand are modes of the `/audio/v1/listen` WebSocket endpoint.
Transcribe uses `POST /audio/v1/transcribe` over HTTP and is not a
WebSocket session mode.

| Mode | Delivery | Best for |
|---|---|---|
| `instant` (default) | Final `Segment` events arrive as audio is decoded. | Live captions and continuously updating displays |
| `demand` | Each `Finalize` gets one `Transcript` per channel, including empty transcripts. `CloseStream` delivers the remainder the same way, then `SessionClosed`. | Voice-agent turns and application-controlled boundaries |

In instant mode, register `on_segment` or consume `events()` as audio is sent:

```python
session = client.connect(mode="instant")  # or omit mode
session.on_segment(lambda segment: render(segment.text))
```

In demand mode, a `Finalize` is a turn boundary. `finalize()` only sends the
control message and returns immediately. Use `finalize_transcript()` when the
voice-agent turn needs its per-channel `Transcript` response:

```python
session = client.connect(mode="demand")
for turn_frames in caller_turns:
    for frame in turn_frames:
        session.send_audio(frame)
    transcripts = session.finalize_transcript()  # one Transcript per channel
    turn_text = " ".join(transcript.text for transcript in transcripts)
    answer_turn(turn_text)

closed = session.close_stream()  # remainder Transcripts, then SessionClosed
```

Each demand `Transcript` has `channel`, `text`, timestamped `words`, and a
`redaction` summary. Demand mode never sends `Segment` events.

**Transcribe** is non-streaming: one HTTP request for a whole recording of up to
five minutes, one result back. No session to manage:

```python
result = client.transcribe("call.wav")
print(result.text, result.audio_duration_seconds)
```

`transcribe` uploads a WAV path as `audio/wav`, preserving its container and
using the header's sample rate and channel count. Raw bytes and paths with
`raw=True` use `application/octet-stream` with `encoding=linear16` and an
explicit `sample_rate`; `channels` may be 1 or 2, with 2 selecting downmix.
The async client has the same method.

A successful response has this shape:

```json
{
  "request_id": "6f58c1c6-7e0c-4bb8-9d72-3fb3d4c5c1aa",
  "text": "i need a dry van",
  "words": [
    {"word": "i", "start": 0.00, "end": 0.12},
    {"word": "need", "start": 0.16, "end": 0.20}
  ],
  "segments": [
    {"start": 0.00, "end": 0.72, "text": "i need a dry van"}
  ],
  "audio_duration_seconds": 0.72,
  "model_info": {"name": "bw-streaming-en", "version": "current"}
}
```

`words` is a timestamped word list and may be empty. `segments` always carries
the typed segment list with `start`, `end`, and `text`.

## Live word display

For word-by-word rendering, `WordAssembler` merges subword pieces into
display words as they grow. With segments `"i need"`, `" a dr"`, `"y van"`
it shows `dr` the instant it is decoded and grows it into `dry`:

```python
from bw_stt import BwSttClient, WordAssembler

client = BwSttClient()
words = WordAssembler()
with client.connect() as session:
    session.on_segment(words.push)
    for _ in session.stream_file("call.wav"):
        print("\r" + " ".join(w.text for w in words.words), end="")
    session.close_stream()
```

Each `DisplayWord` carries `start` and `end` timestamps spanning its first
piece to its last. See `examples/transcribe_wav.py` for a complete CLI.

## PII redaction

Ask the service to redact common US PII categories in results:

| Option | Type | Default | Description |
|---|---|---|---|
| `redact_pii` | `bool` | `False` | Redact personally identifiable information. |
| `redact_pii_sub` | `str` | unset | Use `entity_name` or `hash` for replacements. |
| `redact_pii_return` | `bool` | `False` | Return redacted entity spans. Requires `redact_pii=True` and hash substitution. |

```python
session = client.connect(
    mode="demand",
    redact_pii=True,
    redact_pii_return=True,  # omit redact_pii_sub to use the server's hash default
)
transcripts = session.finalize_transcript()
for transcript in transcripts:
    entities_by_token = {entity.token: entity for entity in transcript.redacted_entities or ()}
    for token in transcript.text.split():
        entity = entities_by_token.get(token)
        if entity is not None:
            print(token, "maps to", entity.text, entity.kind, entity.start, entity.end)
```

The demand transcript includes a summary such as:

```json
{
  "type": "Transcript",
  "channel": 0,
  "text": "my number is [redacted]",
  "words": [],
  "redaction": {
    "applied": true,
    "entities_redacted": 1
  },
  "redacted_entities": [
    {
      "token": "hash:v1:9f2c41d08ab37e15",
      "kind": "pii",
      "text": "123-45-6789",
      "start": 2.10,
      "end": 2.45
    }
  ]
}
```

`redacted_entities` is `None` when the server omits the field and an empty
tuple when the server sends an empty array. Each returned `token` is the exact
hash token in the redacted text, so it can be joined to the corresponding
entity. `start` and `end` are `None` when the server has no timestamps. The
same options apply to `transcribe()`. When `redact_pii_return=True`,
`redact_pii_sub="entity_name"` is invalid. Redaction covers common US PII
categories selected by the service.

## Keyword boosting

Bias recognition toward domain terms by passing up to 100 keywords with a
combined limit of 4096 UTF-8 bytes:

```python
session = client.connect(keywords=["dry van", "reefer", "LTL"])
result = client.transcribe("call.wav", keywords=["dry van"])
```

## Error handling

Failures before the WebSocket upgrade raise typed exceptions:
`AuthenticationError` (401/403), `RateLimitError` (429, with `retry_after`
when the server supplies it), `ServiceUnavailableError` (5xx and transport
failures, including connect and transcribe timeouts). In-band protocol
errors, including `transcript_too_large`, are delivered as `ErrorEvent` values
from `events()`, not raised;
when the server closes after one, the SDK raises `ConnectionClosedError`
carrying that event. `events()` does not yield SessionOpened; it is
available as `session.opened`:

The SDK preserves the server error code as a string. Published codes include
`invalid_params`, `invalid_message`, `invalid_frame`, `idle_timeout`,
`identity_revalidation_failed`, `upstream_unavailable`,
`transcript_too_large`, and `internal_error`.

```python
from bw_stt import ConnectionClosedError, ErrorEvent, RateLimitError

try:
    with client.connect() as session:
        for event in session.events():
            if isinstance(event, ErrorEvent):
                print("server error:", event.code, event.message)
except RateLimitError as exc:
    print("retry after", exc.retry_after)
except ConnectionClosedError as exc:
    print("closed:", exc.error_event)
```

There is no resume protocol: after an unexpected close, reconnecting starts a
new session, and you decide what audio to send again.

## Sessions and framing

Audio frames must be 20 to 1000 ms of complete samples; `stream_chunks()` and
`stream_file()` handle the 160 ms framing for you from arbitrary chunk sizes.
Opus is different: send exactly one raw encoder packet per `send_audio()`
call. The SDK sends `KeepAlive` automatically during send-side quiet
(`keepalive_interval`, default 25 s) to stay inside the 60 s idle deadline;
pass `None` or `0` to disable it. `connect()` waits up to `connect_timeout`
seconds (default 15) for the session to open. A failed final delivery is
reported by `SessionClosed.delivery_failed`.

## Overriding the endpoint

`base_url` accepts `ws`, `wss`, `http`, or `https` URLs; `http(s)` is
normalized to `ws(s)` for streaming and `ws(s)` to `http(s)` for
`transcribe()`. A base URL without a path gets the standard paths appended
(`/audio/v1/listen` and `/audio/v1/transcribe`); a custom path is used
verbatim for streaming, with `/transcribe` substituted for a trailing
`/listen` (or appended) for `transcribe()`:

```python
client = BwSttClient(base_url="wss://gateway.example.com")
```

## API reference

Full protocol documentation:
[Bandwidth Labs speech-to-text API reference](https://labs.bandwidth.com/docs/speech-to-text).
