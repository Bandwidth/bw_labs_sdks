import type { Segment } from "./events";

/**
 * Builds the running transcript by verbatim concatenation of segment text.
 * Segments carry their own leading spaces; never insert separators.
 */
export class TranscriptAssembler {
  private buffer = "";

  /** Appends one segment and returns the full transcript so far. */
  push(segment: Pick<Segment, "text">): string {
    this.buffer += segment.text;
    return this.buffer;
  }

  get text(): string {
    return this.buffer;
  }
}

/** A display word merged from one or more subword pieces. */
export interface DisplayWord {
  text: string;
  /** Seconds; spans the first piece's start. */
  start: number;
  /** Seconds; extends to the latest piece's end. */
  end: number;
}

/**
 * Builds display words for live rendering. A segment whose text starts with a
 * space begins a new word; one without a leading space continues the previous
 * word in place (subword pieces), extending its text and end time. Use one
 * assembler per channel in multichannel sessions.
 */
export class WordAssembler {
  private readonly list: DisplayWord[] = [];

  /**
   * Merges one segment and returns the assembler's live word list. The same
   * array instance is returned on every call and grows in place.
   */
  push(segment: Pick<Segment, "text" | "words">): DisplayWord[] {
    const continuesPrevious = !segment.text.startsWith(" ") && this.list.length > 0;
    segment.words.forEach((word, index) => {
      if (index === 0 && continuesPrevious) {
        const previous = this.list[this.list.length - 1]!;
        previous.text += word.word;
        previous.end = word.end;
      } else {
        this.list.push({ text: word.word, start: word.start, end: word.end });
      }
    });
    return this.list;
  }

  get words(): readonly DisplayWord[] {
    return this.list;
  }

  /** The current words joined with single spaces. */
  get text(): string {
    return this.list.map((word) => word.text).join(" ");
  }
}
