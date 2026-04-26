#!/usr/bin/env python3
"""
Transcribe audio/video files using local OpenAI Whisper.
Produces .txt (clean text), .srt (subtitles), and .json (timestamped segments).
Auto-detects GPU/CPU and selects the best model for your hardware.

Usage:
  transcribe.py interview.mp4
  transcribe.py podcast.mp3 --format txt
  transcribe.py meeting.m4a --format srt,txt --output-dir ./out
  transcribe.py audio.wav --stdout
"""
import argparse
import json
import shutil
import sys
from datetime import timedelta
from pathlib import Path

# Wire in self-healing hooks
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from _lib import hooks  # noqa: E402


SUPPORTED_EXT = {".mp3", ".mp4", ".m4a", ".wav", ".ogg", ".flac", ".webm", ".mpeg", ".mpga", ".avi", ".mkv", ".mov"}

# Local op — no network host. Use the file extension as a sub-tag at recall time.
HOST = None
OP = "transcribe"


def check_dependencies():
    """Check all required dependencies and give actionable error messages."""
    errors = []

    # Check ffmpeg
    if not shutil.which("ffmpeg"):
        errors.append(
            "ffmpeg not found in PATH.\n"
            "  Install: sudo apt install ffmpeg (Linux) | brew install ffmpeg (macOS)"
        )

    # Check whisper
    try:
        import whisper  # noqa: F401
    except ImportError:
        errors.append(
            "openai-whisper not installed.\n"
            "  Install: pip install openai-whisper"
        )

    # Check torch
    try:
        import torch  # noqa: F401
    except ImportError:
        errors.append(
            "PyTorch not installed (required by whisper).\n"
            "  Install: pip install openai-whisper (installs torch as dependency)"
        )

    if errors:
        joined = "\n  ✗ ".join([""] + errors)
        hooks.fail_and_exit(
            host=HOST, op=OP,
            err=Exception("Missing dependencies:" + joined),
            err_class="missing_dep",
            cmd="transcribe.py (dep check)",
        )


def detect_device():
    """Detect the best available device and report details."""
    import torch

    if torch.cuda.is_available():
        name = torch.cuda.get_device_name(0)
        vram_bytes = torch.cuda.get_device_properties(0).total_memory
        vram_gb = vram_bytes / (1024 ** 3)
        print(f"GPU detected: {name} ({vram_gb:.1f} GB VRAM)", file=sys.stderr)
        return "cuda", vram_gb
    else:
        print("No GPU detected — using CPU (transcription will be slower)", file=sys.stderr)
        return "cpu", 0


def auto_select_model(device: str, vram_gb: float) -> str:
    """Pick the best model for the available hardware."""
    if device == "cpu":
        model = "base"
        print(f"Auto-selected model: {model} (best for CPU)", file=sys.stderr)
        return model

    if vram_gb >= 8:
        model = "turbo"
    elif vram_gb >= 4:
        model = "small"
    else:
        model = "base"

    print(f"Auto-selected model: {model} (for {vram_gb:.0f} GB VRAM)", file=sys.stderr)
    return model


def format_srt_time(seconds: float) -> str:
    td = timedelta(seconds=seconds)
    h = int(td.total_seconds() // 3600)
    m = int((td.total_seconds() % 3600) // 60)
    s = int(td.total_seconds() % 60)
    ms = int((td.total_seconds() % 1) * 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def build_srt(segments: list) -> str:
    lines = []
    for i, seg in enumerate(segments, 1):
        start = format_srt_time(seg["start"])
        end = format_srt_time(seg["end"])
        text = seg["text"].strip()
        lines.append(f"{i}\n{start} --> {end}\n{text}\n")
    return "\n".join(lines)


def transcribe(
    file_path: str,
    model_name: str | None = None,
    language: str | None = None,
    output_dir: str | None = None,
    name_override: str | None = None,
    formats: list[str] | None = None,
    to_stdout: bool = False,
    device: str | None = None,
) -> dict:
    import whisper

    file_path = Path(file_path).resolve()
    if not file_path.exists():
        hooks.fail_and_exit(
            host=HOST, op=OP,
            err=FileNotFoundError(f"File not found: {file_path}"),
            err_class="file_not_found",
            cmd=f"transcribe.py {file_path}",
            args={"file": str(file_path)},
        )

    ext = file_path.suffix.lower()
    if ext not in SUPPORTED_EXT:
        hooks.fail_and_exit(
            host=HOST, op=OP,
            err=ValueError(f"Unsupported format '{ext}'. Supported: {', '.join(sorted(SUPPORTED_EXT))}"),
            err_class="unsupported_format",
            cmd=f"transcribe.py {file_path}",
            args={"file": str(file_path), "ext": ext},
        )

    if formats is None:
        formats = ["txt", "srt", "json"]

    # Determine output paths
    stem = name_override or file_path.stem
    out_dir = Path(output_dir) if output_dir else file_path.parent
    out_dir.mkdir(parents=True, exist_ok=True)

    # Detect device and pick model
    if device is None:
        device, vram_gb = detect_device()
    else:
        vram_gb = 0
        print(f"Using device: {device} (manual override)", file=sys.stderr)

    if model_name is None:
        model_name = auto_select_model(device, vram_gb)

    size_mb = file_path.stat().st_size / 1e6
    print(f"Transcribing: {file_path.name} ({size_mb:.1f} MB)", file=sys.stderr)
    print(f"Model: {model_name} | Language: {language or 'auto-detect'} | Device: {device}", file=sys.stderr)

    # Load model and transcribe
    try:
        model = whisper.load_model(model_name, device=device)
    except RuntimeError as e:
        if "out of memory" in str(e).lower() or "CUDA" in str(e):
            hooks.fail_and_exit(
                host=HOST, op=OP, err=e,
                err_class="oom",
                cmd=f"transcribe.py {file_path} --model {model_name}",
                args={"model": model_name, "device": device},
            )
        raise

    transcribe_kwargs = {"verbose": False}
    if language:
        transcribe_kwargs["language"] = language

    try:
        result = model.transcribe(str(file_path), **transcribe_kwargs)
    except RuntimeError as e:
        if "out of memory" in str(e).lower():
            hooks.fail_and_exit(
                host=HOST, op=OP, err=e,
                err_class="oom",
                cmd=f"transcribe.py {file_path} --model {model_name}",
                args={"model": model_name, "device": device},
            )
        raise

    text = result["text"].strip()
    segments = result.get("segments", [])
    duration = segments[-1]["end"] if segments else 0
    detected_lang = result.get("language", language or "unknown")

    # --stdout mode
    if to_stdout:
        print(text)
        return {"text": text, "duration": duration}

    written = []

    # .txt
    if "txt" in formats:
        txt_path = out_dir / f"{stem}.txt"
        txt_path.write_text(text, encoding="utf-8")
        written.append(str(txt_path))

    # .srt
    if "srt" in formats:
        if not segments:
            print("Warning: No segments returned, skipping SRT.", file=sys.stderr)
        else:
            srt_path = out_dir / f"{stem}.srt"
            srt_path.write_text(build_srt(segments), encoding="utf-8")
            written.append(str(srt_path))

    # .json
    if "json" in formats:
        json_out = {
            "text": text,
            "language": detected_lang,
            "duration_seconds": duration,
            "segments": [
                {"start": s["start"], "end": s["end"], "text": s["text"].strip()}
                for s in segments
            ],
            "model": model_name,
            "device": device,
            "source_file": file_path.name,
        }
        json_path = out_dir / f"{stem}.json"
        json_path.write_text(json.dumps(json_out, indent=2, ensure_ascii=False), encoding="utf-8")
        written.append(str(json_path))

    # Summary
    print(f"\nLanguage: {detected_lang}", file=sys.stderr)
    print(f"Duration: {duration:.0f}s ({duration / 60:.1f} min)", file=sys.stderr)
    print(f"Segments: {len(segments)}", file=sys.stderr)
    for p in written:
        print(f"Wrote: {p}", file=sys.stderr)

    return {"text": text, "duration": duration, "written": written}


def main():
    parser = argparse.ArgumentParser(
        description="Transcribe audio/video with local OpenAI Whisper"
    )
    parser.add_argument("file", help="Audio or video file to transcribe")
    parser.add_argument("--format", default="txt,srt,json",
                        help="Comma-separated output formats: txt, srt, json (default: all three)")
    parser.add_argument("--output-dir", help="Output directory (default: same as input file)")
    parser.add_argument("--name", help="Override output filename stem")
    parser.add_argument("--model", default=None,
                        help="Whisper model: tiny, base, small, medium, large-v3, turbo (default: auto)")
    parser.add_argument("--language", default=None,
                        help="Language code, e.g. en, es, fr (default: auto-detect)")
    parser.add_argument("--device", help="Device: cuda, cpu (default: auto-detect)")
    parser.add_argument("--stdout", action="store_true",
                        help="Print plain text to stdout only (no files written)")
    args = parser.parse_args()

    # PRE — recall any prior transcribe-related fixes (oom, codec, language)
    ext = Path(args.file).suffix.lstrip(".").lower() or "?"
    hooks.recall_and_emit(
        f"transcribe {ext} {args.model or 'auto'}",
        host=HOST, op=OP,
        tags=[f"format-{ext}"] if ext != "?" else None,
    )

    # Check deps before doing anything
    check_dependencies()

    formats = [f.strip().lower() for f in args.format.split(",")]

    try:
        transcribe(
            file_path=args.file,
            model_name=args.model,
            language=args.language,
            output_dir=args.output_dir,
            name_override=args.name,
            formats=formats,
            to_stdout=args.stdout,
            device=args.device,
        )
    except SystemExit:
        raise
    except KeyboardInterrupt:
        print("\nInterrupted.", file=sys.stderr)
        sys.exit(130)
    except Exception as e:
        hooks.fail_and_exit(
            host=HOST, op=OP, err=e,
            cmd=f"transcribe.py {args.file}",
            args={"file": args.file, "model": args.model, "language": args.language},
        )


if __name__ == "__main__":
    main()
