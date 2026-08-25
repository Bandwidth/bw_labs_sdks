import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildWav } from "./helpers/audio";
import { MockSttServer } from "./helpers/mock-server";

const run = promisify(execFile);
const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("examples/transcribe-wav.mts", () => {
  let server: MockSttServer;
  let directory: string;
  let wavPath: string;

  beforeAll(async () => {
    const streamed = ["i need", " a dr"];
    server = await MockSttServer.start({
      onAudio: (connection) => {
        const text = streamed[connection.audioFrames.length - 1];
        if (text !== undefined) {
          connection.send({
            type: "Segment",
            channel: 0,
            start: 0,
            end: 0.2,
            text,
            words:
              text === "i need"
                ? [
                    { word: "i", start: 0.0, end: 0.12 },
                    { word: "need", start: 0.16, end: 0.2 },
                  ]
                : [
                    { word: "a", start: 0.24, end: 0.32 },
                    { word: "dr", start: 0.36, end: 0.44 },
                  ],
          });
        }
      },
      closeScript: () => [
        {
          type: "Segment",
          channel: 0,
          start: 0.48,
          end: 0.72,
          text: "y van",
          words: [
            { word: "y", start: 0.48, end: 0.56 },
            { word: "van", start: 0.6, end: 0.72 },
          ],
        },
      ],
    });
    directory = await mkdtemp(join(tmpdir(), "bw-stt-example-"));
    wavPath = join(directory, "sample.wav");
    // 0.5 s of 16 kHz mono PCM16: three 5120-byte frames plus a 640-byte tail.
    await writeFile(wavPath, buildWav({ sampleRate: 16000, channels: 1, samplesPerChannel: 8000 }));
  });

  afterAll(async () => {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("streams the file against the mock server and prints the transcript and usage", async () => {
    const { stdout } = await run(
      process.execPath,
      ["--import", "tsx", join("examples", "transcribe-wav.mts"), wavPath, "--rate", "16000"],
      {
        cwd: packageRoot,
        env: {
          ...process.env,
          BW_STT_API_KEY: "bwa_key_test",
          BW_STT_BASE_URL: server.url,
        },
        timeout: 30000,
      },
    );
    expect(stdout).toContain("i need a dry van");
    expect(stdout).toContain("audio seconds: 0.50");
  }, 30000);
});
