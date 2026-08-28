import { describe, expect, it } from "vitest";
import { BwSttClient } from "../src/client";
import type { Transport, TransportHandlers } from "../src/transport";
import { pcmBytes } from "./helpers/audio";
import { waitFor } from "./helpers/mock-server";

const KEY = "bwa_key_test";

const OPENED = JSON.stringify({
  type: "SessionOpened",
  request_id: "req-1",
  model_info: { name: "bw-streaming-en", version: "current" },
  channels: 1,
  sample_rate: 16000,
  encoding: "linear16",
});

interface MockSocketState {
  sent: (string | Uint8Array)[];
  bufferedAmount: number;
  handlers: TransportHandlers;
}

function mockTransport(): { transport: Transport; state: MockSocketState } {
  const state = { sent: [], bufferedAmount: 0 } as unknown as MockSocketState;
  const transport: Transport = (_request, handlers) => {
    state.handlers = handlers;
    return Promise.resolve({
      send: (data: string | Uint8Array) => {
        state.sent.push(data);
      },
      close: () => {},
      get bufferedAmount() {
        return state.bufferedAmount;
      },
    });
  };
  return { transport, state };
}

function audioFrames(state: MockSocketState): Uint8Array[] {
  return state.sent.filter((data): data is Uint8Array => typeof data !== "string");
}

describe("send backpressure", () => {
  it("streamChunks waits for the socket to drain when bufferedAmount is high", async () => {
    const { transport, state } = mockTransport();
    const client = new BwSttClient({ apiKey: KEY, transport });
    const pending = client.connect({ keepAliveIntervalMs: 0 });
    state.handlers.onTextMessage(OPENED);
    const session = await pending;
    state.bufferedAmount = 2 * 1024 * 1024;
    const streaming = (async () => {
      for await (const _segment of session.streamChunks([pcmBytes(5120), pcmBytes(5120)])) {
        // no segments scripted
      }
    })();
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(audioFrames(state)).toHaveLength(0);
    state.bufferedAmount = 0;
    await waitFor(() => audioFrames(state).length === 2);
    await streaming;
    session.disconnect();
  });

  it("streamChunks sends immediately below the drain threshold", async () => {
    const { transport, state } = mockTransport();
    const client = new BwSttClient({ apiKey: KEY, transport });
    const pending = client.connect({ keepAliveIntervalMs: 0 });
    state.handlers.onTextMessage(OPENED);
    const session = await pending;
    state.bufferedAmount = 1024;
    const streaming = (async () => {
      for await (const _segment of session.streamChunks([pcmBytes(5120)])) {
        // no segments scripted
      }
    })();
    await waitFor(() => audioFrames(state).length === 1);
    await streaming;
    session.disconnect();
  });
});
