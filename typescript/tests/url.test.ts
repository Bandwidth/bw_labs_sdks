import { describe, expect, it } from "vitest";
import { buildListenUrl, buildTranscribeUrl, resolveAuthCarrier } from "../src/options";

describe("buildListenUrl", () => {
  it("appends the listen path and explicit defaults to a bare base URL", () => {
    const url = new URL(buildListenUrl("wss://api.labs.bandwidth.com", {}));
    expect(url.protocol).toBe("wss:");
    expect(url.pathname).toBe("/audio/v1/listen");
    expect(url.searchParams.get("encoding")).toBe("linear16");
    expect(url.searchParams.get("sample_rate")).toBe("16000");
    expect(url.searchParams.get("channels")).toBe("1");
    expect(url.searchParams.get("multichannel")).toBeNull();
    expect(url.searchParams.get("model")).toBeNull();
    expect(url.searchParams.get("mode")).toBeNull();
    expect(url.searchParams.get("api_key")).toBeNull();
  });

  it("maps every connect option to its wire parameter", () => {
    const url = new URL(
      buildListenUrl("wss://api.labs.bandwidth.com", {
        encoding: "mulaw",
        sampleRate: 8000,
        channels: 2,
        multichannel: true,
        model: "pinned-tag",
        mode: "demand",
      }),
    );
    expect(url.searchParams.get("encoding")).toBe("mulaw");
    expect(url.searchParams.get("sample_rate")).toBe("8000");
    expect(url.searchParams.get("channels")).toBe("2");
    expect(url.searchParams.get("multichannel")).toBe("true");
    expect(url.searchParams.get("model")).toBe("pinned-tag");
    expect(url.searchParams.get("mode")).toBe("demand");
  });

  it("carries the API key as a query parameter when requested", () => {
    const url = new URL(buildListenUrl("wss://api.labs.bandwidth.com", {}, "bwa_key_x/y=z"));
    expect(url.searchParams.get("api_key")).toBe("bwa_key_x/y=z");
  });

  it("keeps an explicit path from the base URL and converts http schemes", () => {
    expect(new URL(buildListenUrl("https://example.com", {})).protocol).toBe("wss:");
    expect(new URL(buildListenUrl("http://example.com", {})).protocol).toBe("ws:");
    const custom = new URL(buildListenUrl("ws://127.0.0.1:9000/custom/listen", {}));
    expect(custom.pathname).toBe("/custom/listen");
  });

  it("maps PII options to their wire parameters", () => {
    const url = new URL(
      buildListenUrl("wss://api.labs.bandwidth.com", {
        redactPii: true,
        redactPiiPolicies: ["ssn", "credit_card"],
        redactPiiSub: "entity_name",
      }),
    );
    expect(url.searchParams.get("redact_pii")).toBe("true");
    expect(url.searchParams.get("redact_pii_policies")).toBe("ssn,credit_card");
    expect(url.searchParams.get("redact_pii_sub")).toBe("entity_name");
  });

  it("omits PII parameters unless enabled", () => {
    const url = new URL(buildListenUrl("wss://api.labs.bandwidth.com", { redactPii: false }));
    expect(url.searchParams.get("redact_pii")).toBeNull();
    expect(url.searchParams.get("redact_pii_policies")).toBeNull();
    expect(url.searchParams.get("redact_pii_sub")).toBeNull();
  });

  it("repeats the keywords parameter once per keyword, encoded", () => {
    const url = new URL(
      buildListenUrl("wss://api.labs.bandwidth.com", { keywords: ["dry van", "reefer", "a&b"] }),
    );
    expect(url.searchParams.getAll("keywords")).toEqual(["dry van", "reefer", "a&b"]);
    expect(url.search).toContain("keywords=dry+van");
  });

  it("rejects more than 100 keywords", () => {
    const keywords = Array.from({ length: 101 }, (_, index) => `kw${index}`);
    expect(() => buildListenUrl("wss://api.labs.bandwidth.com", { keywords })).toThrow(RangeError);
  });

  it("rejects empty keywords", () => {
    expect(() => buildListenUrl("wss://api.labs.bandwidth.com", { keywords: [""] })).toThrow(TypeError);
  });

  it("rejects whitespace-only keywords", () => {
    expect(() => buildListenUrl("wss://api.labs.bandwidth.com", { keywords: ["   "] })).toThrow(TypeError);
    expect(() => buildListenUrl("wss://api.labs.bandwidth.com", { keywords: ["\t\n"] })).toThrow(TypeError);
  });

  it("rejects invalid media combinations", () => {
    expect(() => buildListenUrl("wss://x", { sampleRate: 44100 })).toThrow(RangeError);
    expect(() => buildListenUrl("wss://x", { channels: 3 })).toThrow(RangeError);
    expect(() => buildListenUrl("wss://x", { multichannel: true })).toThrow(RangeError);
    expect(() => buildListenUrl("wss://x", { encoding: "g722", sampleRate: 8000 })).toThrow(RangeError);
    expect(() => buildListenUrl("wss://x", { encoding: "opus", channels: 2 })).toThrow(RangeError);
    expect(() => buildListenUrl("wss://x", { encoding: "mp3" as never })).toThrow(TypeError);
    expect(() => buildListenUrl("ftp://x", {})).toThrow(TypeError);
  });
});

describe("buildTranscribeUrl", () => {
  it("derives the https transcribe endpoint from a wss base URL", () => {
    const url = new URL(buildTranscribeUrl("wss://api.labs.bandwidth.com", {}));
    expect(url.protocol).toBe("https:");
    expect(url.pathname).toBe("/audio/v1/transcribe");
  });

  it("replaces a trailing /listen path with /transcribe", () => {
    const url = new URL(buildTranscribeUrl("ws://127.0.0.1:9000/audio/v1/listen", {}));
    expect(url.protocol).toBe("http:");
    expect(url.pathname).toBe("/audio/v1/transcribe");
  });

  it("appends /transcribe to any other custom path", () => {
    expect(new URL(buildTranscribeUrl("wss://gw.example.com/stt", {})).pathname).toBe("/stt/transcribe");
    expect(new URL(buildTranscribeUrl("https://gw.example.com/stt/", {})).pathname).toBe("/stt/transcribe");
  });

  it("keeps http and https bases on their scheme", () => {
    expect(new URL(buildTranscribeUrl("http://example.com", {})).protocol).toBe("http:");
    expect(new URL(buildTranscribeUrl("http://example.com", {})).pathname).toBe("/audio/v1/transcribe");
    expect(new URL(buildTranscribeUrl("https://example.com", {})).protocol).toBe("https:");
  });

  it("carries media, PII, and keyword parameters", () => {
    const url = new URL(
      buildTranscribeUrl("wss://api.labs.bandwidth.com", {
        encoding: "linear16",
        sampleRate: 8000,
        channels: 2,
        model: "pinned",
        redactPii: true,
        redactPiiSub: "hash",
        keywords: ["alpha", "beta"],
      }),
    );
    expect(url.searchParams.get("encoding")).toBe("linear16");
    expect(url.searchParams.get("sample_rate")).toBe("8000");
    expect(url.searchParams.get("channels")).toBe("2");
    expect(url.searchParams.get("multichannel")).toBeNull();
    expect(url.searchParams.get("model")).toBe("pinned");
    expect(url.searchParams.get("redact_pii")).toBe("true");
    expect(url.searchParams.get("redact_pii_sub")).toBe("hash");
    expect(url.searchParams.getAll("keywords")).toEqual(["alpha", "beta"]);
  });

  it("omits raw-only format parameters for WAV uploads", () => {
    const url = new URL(
      buildTranscribeUrl(
        "wss://api.labs.bandwidth.com",
        { channels: 2, model: "pinned" },
        false,
      ),
    );
    expect(url.searchParams.get("encoding")).toBeNull();
    expect(url.searchParams.get("sample_rate")).toBeNull();
    expect(url.searchParams.get("channels")).toBe("2");
    expect(url.searchParams.get("model")).toBe("pinned");
  });
});

describe("resolveAuthCarrier", () => {
  it("auto selects the header in Node and the query parameter elsewhere", () => {
    expect(resolveAuthCarrier("auto", true)).toBe("header");
    expect(resolveAuthCarrier("auto", false)).toBe("query");
  });

  it("honors explicit carriers", () => {
    expect(resolveAuthCarrier("header", false)).toBe("header");
    expect(resolveAuthCarrier("query", true)).toBe("query");
  });
});
