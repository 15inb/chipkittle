#!/usr/bin/env python3
"""Generate a WAV file with kokoro-onnx for the Chipkittle Discord TTS bot."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import soundfile as sf
from kokoro_onnx import Kokoro


def main() -> int:
    parser = argparse.ArgumentParser(description="Generate speech with Kokoro ONNX.")
    parser.add_argument("--model", required=True, help="Path to kokoro-v1.0.onnx")
    parser.add_argument("--voices", required=True, help="Path to voices-v1.0.bin")
    parser.add_argument("--output", required=True, help="Output WAV path")
    parser.add_argument("--voice", default="af_sarah", help="Kokoro voice id")
    parser.add_argument("--speed", type=float, default=1.0, help="Speech speed")
    parser.add_argument("--lang", default="en-us", help="Language code")
    parser.add_argument("text", nargs="*", help="Text to speak. Reads stdin when omitted.")
    args = parser.parse_args()

    text = " ".join(args.text).strip() or sys.stdin.read().strip()
    if not text:
        raise SystemExit("No text was provided.")

    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)

    kokoro = Kokoro(args.model, args.voices)
    samples, sample_rate = kokoro.create(text, voice=args.voice, speed=args.speed, lang=args.lang)
    sf.write(output, samples, sample_rate)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
