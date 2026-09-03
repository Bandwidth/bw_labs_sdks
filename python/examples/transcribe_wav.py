"""Stream a WAV or raw PCM file and print words as they arrive.

Usage:
    python examples/transcribe_wav.py <audio.wav|raw.pcm> [--raw] [--rate 16000]

Requires BW_STT_API_KEY in the environment. BW_STT_BASE_URL overrides the
endpoint, which is useful for testing.
"""

from __future__ import annotations

import argparse
import os
import sys

from bw_stt import BwSttClient, TranscriptAssembler, WordAssembler

_LIVE_WINDOW = 12


def render(words: WordAssembler) -> None:
    tail = words.words[-_LIVE_WINDOW:]
    print("\r" + " ".join(w.text for w in tail), end="", flush=True)


def main() -> int:
    parser = argparse.ArgumentParser(description="Transcribe an audio file.")
    parser.add_argument("path", help="a 16-bit PCM WAV file, or raw PCM with --raw")
    parser.add_argument(
        "--raw", action="store_true", help="treat the file as raw headerless linear16 PCM"
    )
    parser.add_argument("--rate", type=int, default=16000, help="sample rate (default 16000)")
    args = parser.parse_args()

    if not os.environ.get("BW_STT_API_KEY"):
        print("set BW_STT_API_KEY first", file=sys.stderr)
        return 2

    client = BwSttClient(base_url=os.environ.get("BW_STT_BASE_URL"))
    words = WordAssembler()
    transcript = TranscriptAssembler()
    with client.connect(sample_rate=args.rate) as session:
        session.on_segment(words.push)
        session.on_segment(transcript.push)
        for _segment in session.stream_file(args.path, raw=args.raw):
            render(words)
        closed = session.close_stream()
        render(words)
        print()
        print(transcript.text.strip())
        print(f"audio seconds: {closed.audio_duration_seconds:.2f}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
