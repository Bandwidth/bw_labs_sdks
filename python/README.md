# bw-stt

Python SDK for the Bandwidth Labs speech-to-text API. Stream audio over a
WebSocket and receive final transcript segments in real time, or send a whole
recording for offline transcription.

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

## The three modes

**Instant** is the server default. Segments are emitted the moment text is
decoded, typically every 160 ms of audio. Use it for live captions and
voice interfaces:

```python
session = client.connect(mode="instant")  # or omit mode
```

**Demand** is protocol-identical on the wire, but results arrive when you ask
for them: send audio, then call `finalize()` (session stays open) or
`close_stream()` and consume the segments that follow. Use it when you batch
audio and want results at utterance boundaries you control:

```python
session = client.connect(mode="demand")
session.send_audio(frame)  # ... keep sending
session.finalize()  # results arrive as Segment events now
```

**Transcribe** is offline: one HTTPS request for a whole recording of up to
about 5 minutes, one result back. No session to manage:

```python
result = client.transcribe("call.wav")
print(result.text, result.audio_duration_seconds)
```

`transcribe` reads a WAV header for the sample rate and channel count, or
accepts raw bytes (and `raw=True` for headerless files) with explicit
parameters. The async client has the same method.

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

Ask the service to redact personally identifiable information in results:

```python
session = client.connect(
    redact_pii=True,
    redact_pii_policies=["ssn", "credit_card"],  # optional narrowing
    redact_pii_sub="entity_name",  # "entity_name" or "hash"
)
```

The same options apply to `transcribe()`. The policy names shown here are
illustrative; the supported list ships with the published API reference.

## Keyword boosting

Bias recognition toward domain terms by passing up to 100 keywords:

```python
session = client.connect(keywords=["dry van", "reefer", "LTL"])
result = client.transcribe("call.wav", keywords=["dry van"])
```

## Error handling

Failures before the WebSocket upgrade raise typed exceptions:
`AuthenticationError` (401/403), `RateLimitError` (429, with `retry_after`
when the server supplies it), `ServiceUnavailableError` (5xx and transport
failures, including connect and transcribe timeouts). In-band protocol
errors are delivered as `ErrorEvent` values from `events()`, not raised;
when the server closes after one, the SDK raises `ConnectionClosedError`
carrying that event. `events()` does not yield SessionOpened; it is
available as `session.opened`:

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
seconds (default 15) for the session to open.

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
