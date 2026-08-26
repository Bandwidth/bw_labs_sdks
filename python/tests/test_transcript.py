from __future__ import annotations

from bw_stt.events import Segment, Word
from bw_stt.transcript import TranscriptAssembler, WordAssembler

SEGMENTS = [
    Segment(
        channel=0,
        start=0.00,
        end=0.20,
        text="i need",
        words=(Word("i", 0.00, 0.12), Word("need", 0.16, 0.20)),
        raw={},
    ),
    Segment(
        channel=0,
        start=0.24,
        end=0.44,
        text=" a dr",
        words=(Word("a", 0.24, 0.32), Word("dr", 0.36, 0.44)),
        raw={},
    ),
    Segment(
        channel=0,
        start=0.48,
        end=0.72,
        text="y van",
        words=(Word("y", 0.48, 0.56), Word("van", 0.60, 0.72)),
        raw={},
    ),
]


def test_transcript_assembler_plain_concat() -> None:
    assembler = TranscriptAssembler()
    texts = [assembler.push(segment) for segment in SEGMENTS]
    assert texts[0] == "i need"
    assert texts[1] == "i need a dr"
    assert texts[2] == "i need a dry van"
    assert assembler.text == "i need a dry van"


def test_word_assembler_grows_partial_words() -> None:
    assembler = WordAssembler()

    words = assembler.push(SEGMENTS[0])
    assert [w.text for w in words] == ["i", "need"]

    words = assembler.push(SEGMENTS[1])
    assert [w.text for w in words] == ["i", "need", "a", "dr"]

    words = assembler.push(SEGMENTS[2])
    assert [w.text for w in words] == ["i", "need", "a", "dry", "van"]

    dry = words[3]
    assert dry.start == 0.36  # first piece's start
    assert dry.end == 0.56  # last piece's end
    assert words[4].start == 0.60
    assert assembler.words == words


def test_word_assembler_leading_space_starts_new_word() -> None:
    assembler = WordAssembler()
    assembler.push(
        Segment(channel=0, start=0.0, end=0.1, text="hi", words=(Word("hi", 0.0, 0.1),), raw={})
    )
    words = assembler.push(
        Segment(
            channel=0, start=0.2, end=0.3, text=" there", words=(Word("there", 0.2, 0.3),), raw={}
        )
    )
    assert [w.text for w in words] == ["hi", "there"]


def test_word_assembler_first_segment_without_space() -> None:
    assembler = WordAssembler()
    words = assembler.push(
        Segment(channel=0, start=0.0, end=0.1, text="go", words=(Word("go", 0.0, 0.1),), raw={})
    )
    assert [w.text for w in words] == ["go"]


def test_word_assembler_empty_segment() -> None:
    assembler = WordAssembler()
    assert assembler.push(Segment(channel=0, start=0.0, end=0.0, text="", words=(), raw={})) == []
