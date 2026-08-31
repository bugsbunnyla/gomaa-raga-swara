#!/usr/bin/env python3
"""
GoMaa Raga Vidya v4.0 — Whisper Transcription Script
Usage: python transcribe.py <audio_file> --model small --language te --word-timestamps --output-format json
"""

import sys
import json
import argparse

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("audio_file")
    parser.add_argument("--model", default="small")
    parser.add_argument("--language", default="")
    parser.add_argument("--word-timestamps", action="store_true")
    parser.add_argument("--output-format", default="json")
    args = parser.parse_args()

    try:
        import whisper
        model = whisper.load_model(args.model)
        opts = {"word_timestamps": args.word_timestamps}
        if args.language:
            opts["language"] = args.language
        result = model.transcribe(args.audio_file, **opts)

        output = {
            "text": result.get("text", ""),
            "language": result.get("language", "unknown"),
            "words": []
        }

        if args.word_timestamps and "segments" in result:
            for seg in result["segments"]:
                for word in seg.get("words", []):
                    output["words"].append({
                        "word": word.get("word", "").strip(),
                        "start": word.get("start", 0),
                        "end": word.get("end", 0),
                        "probability": word.get("probability", 0.5)
                    })

        print(json.dumps(output, ensure_ascii=False))
    except Exception as e:
        print(json.dumps({"error": str(e), "text": "", "words": []}), file=sys.stderr)
        sys.exit(1)

if __name__ == "__main__":
    main()
