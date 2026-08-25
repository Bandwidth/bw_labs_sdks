"""Helpers that turn Segment events into display text."""

from __future__ import annotations

from dataclasses import dataclass

from .events import Segment

__all__ = ["DisplayWord", "TranscriptAssembler", "WordAssembler"]


class TranscriptAssembler:
    """Rebuild the full transcript by plain concatenation of segment text.

    For a split-stereo session (``multichannel=True``), use one assembler
    per channel.
    """

    def __init__(self) -> None:
        self._text = ""

    @property
    def text(self) -> str:
        """The transcript assembled so far."""
        return self._text

    def push(self, segment: Segment) -> str:
        """Append one segment and return the current full transcript."""
        self._text += segment.text
        return self._text


@dataclass(frozen=True)
class DisplayWord:
    """One merged display word spanning its first piece's start to its last piece's end."""

    text: str
    start: float
    end: float


class WordAssembler:
    """Merge segment word pieces into display words for live rendering.

    A segment whose text starts with a space begins a new word; one without
    a leading space continues the previous word, so its first word entry
    extends the last display word in place. For a split-stereo session
    (``multichannel=True``), use one assembler per channel.
    """

    def __init__(self) -> None:
        self._words: list[DisplayWord] = []

    @property
    def words(self) -> list[DisplayWord]:
        """The display words merged so far."""
        return list(self._words)

    def push(self, segment: Segment) -> list[DisplayWord]:
        """Merge one segment and return the current display words."""
        continues = bool(self._words) and not segment.text.startswith(" ")
        for index, word in enumerate(segment.words):
            if index == 0 and continues:
                last = self._words[-1]
                self._words[-1] = DisplayWord(last.text + word.word, last.start, word.end)
            else:
                self._words.append(DisplayWord(word.word, word.start, word.end))
        return list(self._words)
