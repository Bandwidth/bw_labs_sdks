# @bandwidth/bw-stt

TypeScript SDK for the Bandwidth Labs streaming speech-to-text API. Works in Node 18+ and in browsers.

Full protocol details are in the [API reference](https://labs.bandwidth.com/docs/speech-to-text).

## Install

```sh
npm install @bandwidth/bw-stt
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

## Listen modes and offline transcribe

Instant and demand are modes of the `/audio/v1/listen` WebSocket endpoint.
Offline transcription uses `POST /audio/v1/transcribe` over HTTP and is not a
WebSocket session mode.

### Instant

The default. `Segment` events stream back the moment text is decoded. Every segment is final and append-only; there are no interim results to reconcile.

```ts
const session = await client.connect(); // mode: "instant" is the server default
session.on("segment", (segment) => render(segment));
```

### Demand

The same wire protocol, but results are held until you ask for them. Feed audio continuously and call `finalize()` when you want the transcript so far, or `closeStream()` for everything at the end. Useful when you only need text at known points, such as the end of a caller turn.

```ts
const session = await client.connect({ mode: "demand" });
session.sendAudio(frame);       // keep feeding audio; nothing streams back yet
session.finalize();             // results for audio so far arrive as Segment events
const closed = await session.closeStream(); // flushes the rest, then SessionClosed
```

### Offline transcribe

Offline transcription of a complete recording (up to five minutes) in one HTTP
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

Ask the service to redact personally identifiable information in results:

```ts
const session = await client.connect({
  redactPii: true,
  redactPiiPolicies: ["ssn", "credit_card"], // optional policy selection
  redactPiiSub: "entity_name",               // or "hash"
});
```

The policy names above are illustrative; consult the API reference for the published list. The same options work on `transcribe` and `transcribeFile`.

## Keyword boosting

Boost recognition of up to 100 domain terms:

```ts
const session = await client.connect({ keywords: ["dry van", "reefer", "backhaul"] });
```

## Error handling

Connection-time and transcribe failures reject with typed errors: `AuthenticationError` (401/403), `RateLimitError` with `retryAfterSeconds` (429), `InvalidRequestError` (400, 413, and other unexpected 4xx on transcribe), and `ServiceUnavailableError` for 5xx and transport-level failures, including network errors and timeouts. `ConnectionClosedError` covers a WebSocket that drops mid-session or an upgrade rejection the transport cannot classify (browsers only expose a generic close).

In-band `Error` events do not throw; they arrive through `session.on("error", ...)` and `session.events()`. If the connection then drops before `SessionClosed`, pending iterators and `closeStream()` reject with a `ConnectionClosedError` whose `lastErrorEvent` carries that event.

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

Invalid local input (bad frame sizes, misaligned samples, too many keywords) throws plain `RangeError` or `TypeError` at the call site.

## Events

All server events are available as a typed union via `session.events()` or `session.on("event", ...)`. `events()` does not yield `SessionOpened`: it is consumed by the connect handshake and available as `session.opened`. Field names are camelCase mappings of the wire names (`audio_duration_seconds` becomes `audioDurationSeconds`), and every event keeps the original payload on `.raw`. Event types this SDK does not know yet are surfaced as `UnknownEvent` rather than dropped.
