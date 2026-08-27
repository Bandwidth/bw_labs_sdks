# @bandwidth/bw-stt

TypeScript SDK for the Bandwidth Labs streaming speech-to-text API. Works in Node 18+ and in browsers.

Full protocol details are in the [API reference](https://labs.bandwidth.com/docs/speech-to-text).

## Install

During the beta, install from a clone of this repository. The package builds
its dist on install via the prepare script.

```sh
git clone https://github.com/Bandwidth/bw_labs_sdks.git
cd bw_labs_sdks/typescript && npm install && cd -
npm install ./bw_labs_sdks/typescript
```

## Quickstart

```ts
import { BwSttClient } from "@bandwidth/bw-stt";

const client = new BwSttClient(); // reads BW_STT_API_KEY from the environment
const session = await client.connect({ encoding: "linear16", sampleRate: 16000 });

session.on("segment", (segment) => process.stdout.write(segment.text));

for await (const segment of session.streamFile("call.wav")) void segment;

const closed = await session.closeStream();
console.log(`\naudio seconds: ${closed.audioDurationSeconds.toFixed(2)}`);
```

In browsers, pass the key explicitly: `new BwSttClient({ apiKey })`. Browsers cannot set WebSocket headers, so the SDK automatically carries the key as an `api_key` query parameter there. In Node it uses the `X-BW-LABS-API-KEY` header. Override with `authCarrier: "header" | "query"` if needed.

### Pointing at another endpoint

`baseUrl` accepts `ws`, `wss`, `http`, or `https`; `http(s)` is converted to `ws(s)` for streaming and back to `http(s)` for transcribe. A baseUrl without a path gets the standard endpoint paths appended (`/audio/v1/listen`, `/audio/v1/transcribe`). A custom path is used verbatim for streaming; for transcribe, a trailing `/listen` is replaced with `/transcribe`, and any other custom path gets `/transcribe` appended.

## Listen modes and Transcribe

Instant and demand are modes of the `/audio/v1/listen` WebSocket endpoint.
Transcribe uses `POST /audio/v1/transcribe` over HTTP and is not a
WebSocket session mode.

| Mode | Delivery | Best for |
|---|---|---|
| `instant` (default) | Final `Segment` events arrive as audio is decoded. | Live captions and continuously updating displays |
| `demand` | Each `Finalize` gets one `Transcript` per channel, including empty transcripts. `CloseStream` delivers the remainder the same way, then `SessionClosed`. | Voice-agent turns and application-controlled boundaries |

### Instant

The default. `Segment` events stream back the moment text is decoded. Every
segment is final and append-only; there are no interim results to reconcile.

```ts
const session = await client.connect(); // mode: "instant" is the server default
session.on("segment", (segment) => render(segment));
```

### Demand

Demand buffers finalized results server-side. Each `Finalize` gets one
`Transcript` per channel, even when that channel is empty. `CloseStream`
delivers the remainder as `Transcript` events, then sends `SessionClosed`.
Demand never sends `Segment` events.

```ts
const session = await client.connect({ mode: "demand" });
for (const turnFrames of callerTurns) {
  for (const frame of turnFrames) session.sendAudio(frame);
  const transcripts = await session.finalizeTranscript();
  const turnText = transcripts.map((transcript) => transcript.text).join(" ");
  answerTurn(turnText);
}

const closed = await session.closeStream(); // remainder Transcripts, then SessionClosed
```

Use `finalize()` instead when the control message should be fire-and-forget.
For an instant versus demand comparison, use `Segment` callbacks for
continuously arriving final pieces, or `Transcript` callbacks and
`finalizeTranscript()` for application-controlled voice-agent turns.

### Transcribe

Whole-recording transcription (up to five minutes) in one HTTP
call. No session to manage.

```ts
const result = await client.transcribeFile("call.wav");
console.log(result.text, result.audioDurationSeconds);

// or from bytes you already have:
const result2 = await client.transcribe(rawLinear16, { encoding: "linear16", sampleRate: 16000 });
```

`transcribeFile` uploads a WAV path as `audio/wav`, preserving its container
and using the header's sample rate and channel count. `transcribe` and
`transcribeFile(..., { raw: true })` upload headerless linear16 bytes as
`application/octet-stream` with `encoding=linear16` and `sample_rate`; channels
may be 1 or 2, with 2 selecting downmix.

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

`words` is a timestamped word list and may be empty. `segments` is a typed
list with `start`, `end`, and `text` fields.

## Streaming audio

`sendAudio` sends one binary frame per call and validates it: 20 to 1000 ms of complete interleaved samples. For Opus, send exactly one raw packet per call; the duration rule does not apply.

`streamChunks` accepts chunks of any size and re-cuts them into exact 160 ms frames with a final 20 to 160 ms tail:

```ts
for await (const segment of session.streamChunks(microphoneChunks)) {
  process.stdout.write(segment.text);
}
```

`streamFile` (Node only) streams a 16-bit PCM WAV file whose format must match the session, or headerless audio with `{ raw: true }`. File streaming is not paced to realtime: the file is sent as fast as the socket drains, so large files buffer according to socket drain rather than playing out at audio speed.

During quiet periods the session sends `KeepAlive` automatically every 25 seconds of send-side silence, well inside the server's 60 second idle deadline. Tune with `keepAliveIntervalMs`; 0 or null disables it.

## Displaying words live

Segments carry raw decoded text deltas, often subword pieces. Two helpers turn them into display text. `TranscriptAssembler` builds the full transcript by plain concatenation. `WordAssembler` maintains a live word list: a piece starting with a space begins a new word, and a piece without one grows the previous word in place, so "dr" appears instantly and becomes "dry" when the next piece arrives.

```ts
import { TranscriptAssembler, WordAssembler } from "@bandwidth/bw-stt";

const transcript = new TranscriptAssembler();
const words = new WordAssembler();
session.on("segment", (segment) => {
  transcript.push(segment);
  const line = words.push(segment).map((word) => word.text).join(" ");
  redraw(line); // "i need a dr" then "i need a dry van"
});
```

See `examples/transcribe-wav.mts` for a complete CLI:

```sh
BW_STT_API_KEY=bwa_key_... node --import tsx examples/transcribe-wav.mts call.wav
```

## PII redaction

Ask the service to redact common US PII categories in results:

| Option | Type | Default | Description |
|---|---|---|---|
| `redactPii` | `boolean` | `false` | Redact personally identifiable information. |
| `redactPiiSub` | `"entity_name" \| "hash"` | unset | Choose the replacement style. |
| `redactPiiReturn` | `boolean` | `false` | Return redacted entity spans. Requires `redactPii: true` and hash substitution. |

```ts
const session = await client.connect({
  mode: "demand",
  redactPii: true,
  redactPiiReturn: true,                      // omit redactPiiSub for the server's hash default
});
const transcripts = await session.finalizeTranscript();
for (const transcript of transcripts) {
  const entitiesByToken = new Map(
    (transcript.redactedEntities ?? []).map((entity) => [entity.token, entity]),
  );
  for (const token of transcript.text.split(/\s+/)) {
    const entity = entitiesByToken.get(token);
    if (entity !== undefined) console.log(token, "maps to", entity.text, entity.kind);
  }
}
```

A demand `Transcript` includes a redaction summary:

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

`redactedEntities` is `undefined` when the server omits the field and an empty
array when the server sends an empty array. Each `token` is the exact hash
token in the redacted text, so it can be joined to the corresponding entity.
`start` and `end` are `null` when the server has no timestamps. The same
options work on `transcribe` and `transcribeFile`. When `redactPiiReturn: true`,
`redactPiiSub: "entity_name"` is invalid. Redaction covers common US PII
categories selected by the service.

## Keyword boosting

Boost recognition of up to 100 domain terms with a combined limit of 4096 UTF-8
bytes:

```ts
const session = await client.connect({ keywords: ["dry van", "reefer", "backhaul"] });
```

## Error handling

Connection-time and transcribe failures reject with typed errors: `AuthenticationError` (401/403), `RateLimitError` with `retryAfterSeconds` (429), `InvalidRequestError` (400, 413, and other unexpected 4xx on transcribe), and `ServiceUnavailableError` for 5xx and transport-level failures, including network errors and timeouts. `ConnectionClosedError` covers a WebSocket that drops mid-session or an upgrade rejection the transport cannot classify (browsers only expose a generic close).

In-band `Error` events, including `transcript_too_large`, do not throw; they
arrive through `session.on("error", ...)` and `session.events()`. If the
connection then drops before `SessionClosed`, pending iterators and
`closeStream()` reject with a `ConnectionClosedError` whose `lastErrorEvent`
carries that event. A failed final delivery is reported by
`SessionClosed.deliveryFailed`.

```ts
import { RateLimitError } from "@bandwidth/bw-stt";

try {
  const session = await client.connect();
} catch (error) {
  if (error instanceof RateLimitError) scheduleRetry(error.retryAfterSeconds);
  else throw error;
}
```

There is no resume protocol: after an unexpected close, connect again and decide what audio to resend.

Invalid local input (bad frame sizes, misaligned samples, too many keywords, or
more than 4096 combined keyword bytes) throws plain `RangeError` or `TypeError`
at the call site.

## Events

All server events are available as a typed union via `session.events()` or
`session.on("event", ...)`. Demand `Transcript` events are also available via
`session.on("transcript", ...)`. `events()` does not yield `SessionOpened`: it
is consumed by the connect handshake and available as `session.opened`. Field
names are camelCase mappings of the wire names (`audio_duration_seconds`
becomes `audioDurationSeconds`), and every event keeps the original payload on
`.raw`. Event types this SDK does not know yet are surfaced as `UnknownEvent`
rather than dropped.
