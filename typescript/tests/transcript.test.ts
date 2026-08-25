import { describe, expect, it } from "vitest";
import { parseEvent } from "../src/events";
import type { Segment } from "../src/events";
import { TranscriptAssembler, WordAssembler } from "../src/transcript";

const DOCS_SEGMENTS = [
  '{"type":"Segment","channel":0,"start":0.00,"end":0.20,"text":"i need","words":[{"word":"i","start":0.00,"end":0.12},{"word":"need","start":0.16,"end":0.20}]}',
  '{"type":"Segment","channel":0,"start":0.24,"end":0.44,"text":" a dr","words":[{"word":"a","start":0.24,"end":0.32},{"word":"dr","start":0.36,"end":0.44}]}',
  '{"type":"Segment","channel":0,"start":0.48,"end":0.72,"text":"y van","words":[{"word":"y","start":0.48,"end":0.56},{"word":"van","start":0.60,"end":0.72}]}',
].map((json) => parseEvent(json) as Segment);

describe("TranscriptAssembler", () => {
  it("reconstructs the transcript by verbatim concatenation", () => {
    const assembler = new TranscriptAssembler();
    for (const segment of DOCS_SEGMENTS) assembler.push(segment);
    expect(assembler.text).toBe("i need a dry van");
  });

  it("returns the running transcript from push", () => {
    const assembler = new TranscriptAssembler();
    expect(assembler.push(DOCS_SEGMENTS[0]!)).toBe("i need");
    expect(assembler.push(DOCS_SEGMENTS[1]!)).toBe("i need a dr");
  });
});

describe("WordAssembler", () => {
  it("grows dr into dry when the continuation piece arrives", () => {
    const assembler = new WordAssembler();
    assembler.push(DOCS_SEGMENTS[0]!);
    const afterSecond = assembler.push(DOCS_SEGMENTS[1]!);
    expect(afterSecond.map((word) => word.text)).toEqual(["i", "need", "a", "dr"]);
    const afterThird = assembler.push(DOCS_SEGMENTS[2]!);
    expect(afterThird.map((word) => word.text)).toEqual(["i", "need", "a", "dry", "van"]);
    expect(assembler.text).toBe("i need a dry van");
  });

  it("spans a merged word from the first piece's start to the last piece's end", () => {
    const assembler = new WordAssembler();
    for (const segment of DOCS_SEGMENTS) assembler.push(segment);
    const dry = assembler.words[3]!;
    expect(dry.text).toBe("dry");
    expect(dry.start).toBe(0.36);
    expect(dry.end).toBe(0.56);
  });

  it("starts a new word when the very first segment has no leading space", () => {
    const assembler = new WordAssembler();
    const words = assembler.push(DOCS_SEGMENTS[0]!);
    expect(words.map((word) => word.text)).toEqual(["i", "need"]);
  });
});
