#!/usr/bin/env python3
"""
docs — Convert documents to/from markdown via pandoc.

Supported source formats:  docx, doc, pptx, odt, rtf, epub, html, latex, rst, org
Supported target formats:  markdown (default), html, pdf (via LaTeX), docx, pptx, odt, rtf, epub

Usage:
    docs.py to-md   <input>           [--out OUTFILE] [--from FORMAT]
    docs.py convert <input> --to FMT  [--out OUTFILE] [--from FORMAT]
    docs.py info    <input>

Examples:
    docs.py to-md report.docx
    docs.py to-md https://example.com/spec.docx --out spec.md
    docs.py convert notes.md --to docx --out notes.docx
    docs.py convert lecture.pptx --to html --out slides.html
    docs.py info report.docx

Exit codes:
    0   success
    1   parse / pandoc failure
    2   missing required dep (pandoc)
    3   bad input (file missing)
"""
from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
import tempfile
import urllib.request
from pathlib import Path
from urllib.error import HTTPError, URLError

# Wire in self-healing hooks
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from _lib import hooks  # noqa: E402


OP = "docs"
DEFAULT_TIMEOUT = 30.0
MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024  # 100 MB

# Mapping from file extension → pandoc input format
EXT_TO_PANDOC_FROM = {
    ".docx": "docx",
    ".doc": "docx",        # pandoc doesn't read legacy .doc; warn user
    ".pptx": "pptx",
    ".odt": "odt",
    ".rtf": "rtf",
    ".epub": "epub",
    ".html": "html",
    ".htm": "html",
    ".tex": "latex",
    ".rst": "rst",
    ".org": "org",
    ".md": "markdown",
    ".markdown": "markdown",
}

# Default target extensions
TARGET_EXT = {
    "markdown": ".md",
    "gfm": ".md",
    "html": ".html",
    "html5": ".html",
    "docx": ".docx",
    "pptx": ".pptx",
    "odt": ".odt",
    "rtf": ".rtf",
    "epub": ".epub",
    "latex": ".tex",
    "pdf": ".pdf",
}


def _is_url(s: str) -> bool:
    return s.startswith("http://") or s.startswith("https://")


def _download(url: str, hint_ext: str = "", timeout: float = DEFAULT_TIMEOUT) -> Path:
    """Fetch a remote document to a tempfile."""
    host = hooks.extract_host(url)
    req = urllib.request.Request(url, headers={
        "User-Agent": "Mozilla/5.0 (compatible; web-tools/0.2; +https://github.com/maha-media/synaps-skills)",
    })
    fd, tmp = tempfile.mkstemp(suffix=hint_ext or ".bin", prefix="web-docs-")
    os.close(fd)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            written = 0
            with open(tmp, "wb") as f:
                while True:
                    chunk = resp.read(64 * 1024)
                    if not chunk:
                        break
                    written += len(chunk)
                    if written > MAX_DOWNLOAD_BYTES:
                        f.close()
                        Path(tmp).unlink(missing_ok=True)
                        hooks.fail_and_exit(
                            host=host, op=OP,
                            err=ValueError(f"Document exceeds {MAX_DOWNLOAD_BYTES} bytes — refusing to download"),
                            err_class="too_large",
                            cmd=f"GET {url}",
                        )
                    f.write(chunk)
        return Path(tmp)
    except HTTPError as e:
        Path(tmp).unlink(missing_ok=True)
        hooks.fail_and_exit(host=host, op=OP, err=e, err_class=f"http_{e.code}", cmd=f"GET {url}")
    except URLError as e:
        Path(tmp).unlink(missing_ok=True)
        hooks.fail_and_exit(host=host, op=OP, err=e, cmd=f"GET {url}")


def _resolve_input(arg: str) -> tuple[Path, str | None, bool]:
    """Return (path, source_url_or_None, is_temp)."""
    if _is_url(arg):
        # Try to preserve the original extension for pandoc auto-detection
        import urllib.parse as up
        path_part = up.urlparse(arg).path
        ext = Path(path_part).suffix.lower()
        p = _download(arg, hint_ext=ext)
        return p, arg, True
    p = Path(arg).expanduser().resolve()
    if not p.exists():
        hooks.fail_and_exit(
            host=None, op=OP,
            err=FileNotFoundError(f"File not found: {p}"),
            err_class="file_not_found", exit=3,
            cmd=f"docs.py {arg}",
        )
    return p, None, False


def _require_pandoc(host: str | None) -> None:
    if shutil.which("pandoc"):
        return
    hooks.fail_and_exit(
        host=host, op=OP,
        err=Exception(
            "pandoc not installed.\n"
            "  Ubuntu/Debian/WSL:  sudo apt install pandoc\n"
            "  macOS:              brew install pandoc\n"
            "  Windows:            https://pandoc.org/installing.html"
        ),
        err_class="missing_dep", exit=2,
        cmd="docs.py",
    )


def _detect_from(path: Path, override: str | None) -> str:
    if override:
        return override
    ext = path.suffix.lower()
    if ext in EXT_TO_PANDOC_FROM:
        return EXT_TO_PANDOC_FROM[ext]
    hooks.fail_and_exit(
        host=None, op=OP,
        err=ValueError(
            f"Cannot infer source format from extension '{ext}'. "
            f"Use --from to specify (e.g. --from docx)."
        ),
        err_class="unknown_format", exit=3,
        cmd=f"docs.py {path}",
    )


def _run_pandoc(in_path: Path, out_path: Path, fmt_from: str, fmt_to: str,
                host: str | None, extra: list[str] | None = None) -> None:
    cmd = ["pandoc", "--from", fmt_from, "--to", fmt_to, "-o", str(out_path)]
    if extra:
        cmd += extra
    cmd.append(str(in_path))
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    except subprocess.TimeoutExpired:
        hooks.fail_and_exit(
            host=host, op=OP, err=Exception("pandoc timed out after 120s"),
            err_class="timeout", cmd=" ".join(cmd),
        )
    if r.returncode != 0:
        msg = r.stderr.strip() or f"pandoc exited {r.returncode}"
        # Common: "Could not convert image" → not fatal, but pandoc still emits useful output
        hooks.fail_and_exit(
            host=host, op=OP,
            err=Exception(msg),
            stderr=r.stderr,
            cmd=" ".join(cmd),
        )


# ── commands ────────────────────────────────────────────────────────────────

def cmd_to_md(args: argparse.Namespace) -> None:
    path, src_url, is_temp = _resolve_input(args.input)
    host = hooks.extract_host(src_url) if src_url else None
    _require_pandoc(host)
    fmt_from = _detect_from(path, args.from_)

    out_path = Path(args.out).expanduser().resolve() if args.out \
        else (Path.cwd() / (path.stem + ".md"))

    try:
        # gfm tends to round-trip cleaner than vanilla markdown for tables/lists
        _run_pandoc(path, out_path, fmt_from, "gfm", host,
                    extra=["--wrap=preserve", "--standalone"])
        print(f"✓ wrote {out_path}")
    finally:
        if is_temp:
            path.unlink(missing_ok=True)


def cmd_convert(args: argparse.Namespace) -> None:
    path, src_url, is_temp = _resolve_input(args.input)
    host = hooks.extract_host(src_url) if src_url else None
    _require_pandoc(host)
    fmt_from = _detect_from(path, args.from_)
    fmt_to = args.to

    if fmt_to == "pdf" and not shutil.which("pdflatex") and not shutil.which("xelatex"):
        hooks.fail_and_exit(
            host=host, op=OP,
            err=Exception(
                "pandoc → PDF requires LaTeX (xelatex or pdflatex).\n"
                "  Ubuntu/Debian/WSL:  sudo apt install texlive-xetex\n"
                "  macOS:              brew install --cask mactex\n"
                "  Or convert to docx/html instead."
            ),
            err_class="missing_dep", exit=2,
            cmd="docs.py convert --to pdf",
        )

    target_ext = TARGET_EXT.get(fmt_to, f".{fmt_to}")
    out_path = Path(args.out).expanduser().resolve() if args.out \
        else (Path.cwd() / (path.stem + target_ext))

    extra = ["--standalone"]
    if fmt_to in ("markdown", "gfm"):
        extra.append("--wrap=preserve")

    try:
        _run_pandoc(path, out_path, fmt_from, fmt_to, host, extra=extra)
        print(f"✓ wrote {out_path}")
    finally:
        if is_temp:
            path.unlink(missing_ok=True)


def cmd_info(args: argparse.Namespace) -> None:
    path, src_url, is_temp = _resolve_input(args.input)
    try:
        size = path.stat().st_size
        ext = path.suffix.lower()
        fmt = EXT_TO_PANDOC_FROM.get(ext, "(unknown — use --from)")
        print(f"Path:        {path}")
        if src_url:
            print(f"Source:      {src_url}")
        print(f"Size:        {size} bytes ({size / 1024:.1f} KB)")
        print(f"Extension:   {ext or '(none)'}")
        print(f"Pandoc fmt:  {fmt}")
        if shutil.which("pandoc"):
            r = subprocess.run(["pandoc", "--list-input-formats"],
                               capture_output=True, text=True, timeout=5)
            if r.returncode == 0 and fmt in r.stdout.split():
                print(f"Pandoc support: yes")
            else:
                print(f"Pandoc support: unknown (run pandoc --list-input-formats)")
        else:
            print("Pandoc:      not installed")
    finally:
        if is_temp:
            path.unlink(missing_ok=True)


# ── main ────────────────────────────────────────────────────────────────────

def main() -> None:
    parser = argparse.ArgumentParser(
        description="Convert documents to/from markdown via pandoc.",
    )
    sub = parser.add_subparsers(dest="command")

    sp = sub.add_parser("to-md", help="Convert to markdown (gfm)")
    sp.add_argument("input", help="Input file path or URL")
    sp.add_argument("--out", help="Output file (default: <stem>.md in cwd)")
    sp.add_argument("--from", dest="from_",
                    help="Override source format (default: from extension)")

    cp = sub.add_parser("convert", help="Convert between formats")
    cp.add_argument("input", help="Input file path or URL")
    cp.add_argument("--to", required=True,
                    help="Target format: markdown, html, docx, pptx, odt, rtf, epub, pdf, latex")
    cp.add_argument("--out", help="Output file (default: <stem>.<ext> in cwd)")
    cp.add_argument("--from", dest="from_",
                    help="Override source format (default: from extension)")

    ip = sub.add_parser("info", help="Show metadata about a file")
    ip.add_argument("input", help="File path or URL")

    args = parser.parse_args()
    if not args.command:
        parser.print_help()
        sys.exit(1)

    host_for_recall = hooks.extract_host(args.input) if _is_url(args.input) else None
    intent_ext = Path(args.input).suffix.lstrip(".").lower() or "?"
    extra_tags = [f"format-{intent_ext}"] if intent_ext != "?" else None
    hooks.recall_and_emit(
        f"docs {args.command}: {args.input[:60]}",
        host=host_for_recall, op=OP, tags=extra_tags,
    )

    try:
        if args.command == "to-md":
            cmd_to_md(args)
        elif args.command == "convert":
            cmd_convert(args)
        elif args.command == "info":
            cmd_info(args)
    except SystemExit:
        raise
    except KeyboardInterrupt:
        sys.exit(130)
    except Exception as e:
        hooks.fail_and_exit(
            host=host_for_recall, op=OP, err=e,
            cmd=f"docs.py {args.command} {args.input}",
            args={"command": args.command, "input": args.input[:200]},
        )


if __name__ == "__main__":
    main()
