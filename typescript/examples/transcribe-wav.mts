// Stream a WAV or raw PCM file and print display words live.
//
//   BW_STT_API_KEY=bwa_key_... node --import tsx examples/transcribe-wav.mts <audio.wav|raw.pcm> [--raw] [--rate 16000]
//
// BW_STT_BASE_URL overrides the endpoint, e.g. for a local test server.
import { BwSttClient, TranscriptAssembler, WordAssembler } from "../src/index";

function usage(): never {
  console.error(
    "usage: node --import tsx examples/transcribe-wav.mts <audio.wav|raw.pcm> [--raw] [--rate 16000]",
  );
  process.exit(2);
}

const args = process.argv.slice(2);
let file: string | undefined;
let raw = false;
let rate = 16000;
for (let index = 0; index < args.length; index++) {
  const arg = args[index];
  if (arg === "--raw") raw = true;
  else if (arg === "--rate") {
    rate = Number(args[++index]);
    if (!Number.isFinite(rate)) usage();
  } else if (file === undefined && arg !== undefined) file = arg;
  else usage();
}
if (file === undefined) usage();

const baseUrl = process.env.BW_STT_BASE_URL;
const client = new BwSttClient(baseUrl === undefined ? {} : { baseUrl });
const session = await client.connect({ sampleRate: rate });

const transcript = new TranscriptAssembler();
const words = new WordAssembler();
session.on("segment", (segment) => {
  transcript.push(segment);
  const line = words
    .push(segment)
    .map((word) => word.text)
    .join(" ");
  process.stdout.write(`\r${line}`);
});

// Segments render through the listener above; this loop drives the audio.
for await (const segment of session.streamFile(file, { raw })) void segment;

const closed = await session.closeStream();
process.stdout.write("\n");
console.log(transcript.text.trim());
console.log(`audio seconds: ${closed.audioDurationSeconds.toFixed(2)}`);
