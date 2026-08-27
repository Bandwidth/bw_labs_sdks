import { describe, expect, it } from "vitest";
import { ProtocolError } from "../src/errors";
import { parseEvent } from "../src/events";

describe("parseEvent", () => {
  it("maps SessionOpened to camelCase and keeps raw", () => {
    const event = parseEvent(
      '{"type":"SessionOpened","request_id":"abc","model_info":{"name":"bw-streaming-en","version":"current"},"channels":1,"sample_rate":16000,"encoding":"linear16"}',
    );
    expect(event).toMatchObject({
      type: "SessionOpened",
      requestId: "abc",
      modelInfo: { name: "bw-streaming-en", version: "current" },
      channels: 1,
      sampleRate: 16000,
      encoding: "linear16",
    });
    expect((event.raw as { request_id: string }).request_id).toBe("abc");
  });

  it("parses Segment words with timestamps", () => {
    const event = parseEvent(
      '{"type":"Segment","channel":1,"start":0.5,"end":0.7,"text":" hello","words":[{"word":"hello","start":0.5,"end":0.7}]}',
    );
    expect(event).toMatchObject({
      type: "Segment",
      channel: 1,
      start: 0.5,
      end: 0.7,
      text: " hello",
      words: [{ word: "hello", start: 0.5, end: 0.7 }],
    });
  });

  it("parses Transcript words and redaction summary", () => {
    const event = parseEvent(
      '{"type":"Transcript","channel":1,"text":"hello","words":[{"word":"hello","start":0,"end":0.4}],"redaction":{"applied":true,"policies":["ssn"],"entities_redacted":1}}',
    );
    expect(event).toMatchObject({
      type: "Transcript",
      channel: 1,
      text: "hello",
      words: [{ word: "hello", start: 0, end: 0.4 }],
      redaction: { applied: true, policies: ["ssn"], entitiesRedacted: 1 },
    });
    if (event.type === "Transcript") expect(event.redaction.entitiesRedacted).toBe(1);
  });

  it("maps SessionClosed billing fields to camelCase", () => {
    const event = parseEvent(
      '{"type":"SessionClosed","request_id":"abc","audio_duration_seconds":184.32,"session_duration_seconds":190.11}',
    );
    expect(event).toMatchObject({
      type: "SessionClosed",
      requestId: "abc",
      audioDurationSeconds: 184.32,
      sessionDurationSeconds: 190.11,
      deliveryFailed: false,
    });
  });

  it("maps a failed SessionClosed delivery flag", () => {
    const event = parseEvent(
      '{"type":"SessionClosed","request_id":"abc","audio_duration_seconds":1,"session_duration_seconds":2,"delivery_failed":true}',
    );
    expect(event).toMatchObject({ type: "SessionClosed", deliveryFailed: true });
  });

  it("parses Error events", () => {
    const event = parseEvent('{"type":"Error","code":"invalid_frame","message":"bad duration"}');
    expect(event).toMatchObject({ type: "Error", code: "invalid_frame", message: "bad duration" });
  });

  it("keeps transcript_too_large as an in-band Error event", () => {
    const event = parseEvent('{"type":"Error","code":"transcript_too_large","message":"too large"}');
    expect(event).toMatchObject({ type: "Error", code: "transcript_too_large" });
  });

  it("surfaces unknown event types with the wire type and full raw payload", () => {
    const event = parseEvent('{"type":"SpeechStarted","offset":1.5}');
    expect(event.type).toBe("Unknown");
    if (event.type === "Unknown") {
      expect(event.eventType).toBe("SpeechStarted");
      expect(event.raw).toEqual({ type: "SpeechStarted", offset: 1.5 });
    }
  });

  it("throws ProtocolError on malformed input", () => {
    expect(() => parseEvent("not json")).toThrow(ProtocolError);
    expect(() => parseEvent('"just a string"')).toThrow(ProtocolError);
    expect(() => parseEvent('{"no_type":true}')).toThrow(ProtocolError);
    expect(() => parseEvent('{"type":"Segment","channel":0}')).toThrow(ProtocolError);
  });
});
