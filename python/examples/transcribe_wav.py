"""Stream a WAV or raw PCM file and print words as they arrive.

Usage:
    python examples/transcribe_wav.py <audio.wav|raw.pcm> [--raw] [--rate 16000]

Requires BW_STT_API_KEY in the environment. BW_STT_BASE_URL overrides the
endpoint, which is useful for testing.
"""

from __future__ import annotations

import argparse
import os
import shutil
import sys
import time

from bw_stt import BwSttClient, TranscriptAssembler, WordAssembler


def render(words: WordAssembler) -> None:
    # Accumulate complete words from the end until they fill the terminal width.
    cols = shutil.get_terminal_size().columns
    result: list[str] = []
    width = 0
    for word in reversed(words.words):
        needed = len(word.text) + (1 if result else 0)
        if width + needed > cols:
            break
        result.insert(0, word.text)
        width += needed
    print("\r" + " ".join(result), end="", flush=True)


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
    t_start = time.monotonic()
    with client.connect(sample_rate=args.rate) as session:
        session.on_segment(words.push)
        session.on_segment(transcript.push)
        for _segment in session.stream_file(args.path, raw=args.raw):
            render(words)
        closed = session.close_stream()
        # Clear the live display line before printing the final transcript.
        print("\r" + " " * shutil.get_terminal_size().columns, end="\r", flush=True)

    elapsed = time.monotonic() - t_start
    audio_s = closed.audio_duration_seconds
    word_count = len(transcript.text.split())

    print(transcript.text.strip())
    print()
    print("--- performance ---")
    print(f"audio:    {int(audio_s // 60)}m {audio_s % 60:.0f}s")
    print(f"elapsed:  {int(elapsed // 60)}m {elapsed % 60:.1f}s")
    print(f"RTF:      {elapsed / audio_s:.3f}x  (real-time = 1.0)")
    print(f"words:    {word_count:,}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
