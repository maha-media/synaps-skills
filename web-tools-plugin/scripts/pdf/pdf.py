#!/usr/bin/env python3
"""
pdf — Extract text and metadata from PDF files (and remote URLs).

Backends:
  - pdftotext (poppler)  → primary text extraction (fast, no Python deps)
  - pdfplumber            → optional layout-aware extraction (--layout)
  - pypdf                 → optional metadata extraction (--meta fallback)

Usage:
    pdf.py text  <url-or-file> [--pages N-M] [--layout]
    pdf.py meta  <url-or-file>
    pdf.py pages <url-or-file>

Examples:
    pdf.py text paper.pdf
    pdf.py text https://arxiv.org/pdf/2310.06825.pdf --pages 1-5
    pdf.py text report.pdf --layout
    pdf.py meta paper.pdf
    pdf.py pages paper.pdf

Exit codes:
    0   success
    1   network / parse failure
    2   missing required dep (pdftotext)
    3   bad input (file missing, range invalid)
"""
from __future__ import annotations

import argparse
import json
import os
import re
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


OP = "pdf"
DEFAULT_TIMEOUT = 30.0
MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024  # 100 MB


def _is_url(s: str) -> bool:
    return s.startswith("http://") or s.startswith("https://")


def _download(url: str, timeout: float = DEFAULT_TIMEOUT) -> Path:
    """Fetch a remote PDF to a tempfile. Returns the path. Auto-logs failure."""
    host = hooks.extract_host(url)
    req = urllib.request.Request(url, headers={
        "User-Agent": "Mozilla/5.0 (compatible; web-tools/0.2; +https://github.com/maha-media/synaps-skills)",
    })
    fd, tmp = tempfile.mkstemp(suffix=".pdf", prefix="web-pdf-")
    os.close(fd)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            ct = (resp.headers.get("Content-Type") or "").lower()
            if "pdf" not in ct and not url.lower().endswith(".pdf"):
                # Not actually a PDF — log and bail
                Path(tmp).unlink(missing_ok=True)
                hooks.fail_and_exit(
                    host=host, op=OP,
                    err=ValueError(f"URL did not return a PDF (Content-Type: {ct or 'unknown'})"),
                    err_class="not_pdf",
                    cmd=f"GET {url}",
                    args={"url": url, "content_type": ct},
                )
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
                            err=ValueError(f"PDF exceeds {MAX_DOWNLOAD_BYTES} bytes — refusing to download"),
                            err_class="too_large",
                            cmd=f"GET {url}",
                        )
                    f.write(chunk)
        return Path(tmp)
    except HTTPError as e:
        Path(tmp).unlink(missing_ok=True)
        hooks.fail_and_exit(
            host=host, op=OP, err=e,
            err_class=f"http_{e.code}",
            cmd=f"GET {url}",
        )
    except URLError as e:
        Path(tmp).unlink(missing_ok=True)
        hooks.fail_and_exit(host=host, op=OP, err=e, cmd=f"GET {url}")
    except Exception as e:
        Path(tmp).unlink(missing_ok=True)
        hooks.fail_and_exit(host=host, op=OP, err=e, cmd=f"GET {url}")


def _resolve_input(arg: str) -> tuple[Path, str | None, bool]:
    """Return (path, source_url_or_None, is_temp)."""
    if _is_url(arg):
        p = _download(arg)
        return p, arg, True
    p = Path(arg).expanduser().resolve()
    if not p.exists():
        hooks.fail_and_exit(
            host=None, op=OP,
            err=FileNotFoundError(f"File not found: {p}"),
            err_class="file_not_found",
            exit=3,
            cmd=f"pdf.py {arg}",
        )
    return p, None, False


def _parse_pages(spec: str | None) -> tuple[int | None, int | None]:
    """Parse a page-range spec like '1-5', '3', '-10', '5-'. Returns (first, last)."""
    if not spec:
        return None, None
    m = re.match(r"^(\d+)?-(\d+)?$", spec)
    if m:
        first = int(m.group(1)) if m.group(1) else None
        last = int(m.group(2)) if m.group(2) else None
        return first, last
    if spec.isdigit():
        n = int(spec)
        return n, n
    hooks.fail_and_exit(
        host=None, op=OP,
        err=ValueError(f"Invalid --pages spec '{spec}'. Use e.g. '1-5', '3', '-10', or '5-'."),
        err_class="bad_args",
        exit=3,
    )


# ── text extraction ─────────────────────────────────────────────────────────

def cmd_text(args: argparse.Namespace) -> None:
    path, src_url, is_temp = _resolve_input(args.input)
    host = hooks.extract_host(src_url) if src_url else None
    first, last = _parse_pages(args.pages)

    try:
        if args.layout:
            _extract_layout(path, first, last)
        else:
            _extract_pdftotext(path, first, last, host)
    finally:
        if is_temp:
            path.unlink(missing_ok=True)


def _extract_pdftotext(path: Path, first: int | None, last: int | None, host: str | None) -> None:
    if not shutil.which("pdftotext"):
        hooks.fail_and_exit(
            host=host, op=OP,
            err=Exception(
                "pdftotext (poppler) not installed.\n"
                "  Ubuntu/Debian/WSL:  sudo apt install poppler-utils\n"
                "  macOS:              brew install poppler\n"
                "  Or use --layout (requires `pip install pdfplumber`)."
            ),
            err_class="missing_dep",
            exit=2,
            cmd="pdf.py text",
        )
    cmd = ["pdftotext"]
    if first is not None:
        cmd += ["-f", str(first)]
    if last is not None:
        cmd += ["-l", str(last)]
    cmd += [str(path), "-"]
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
    except subprocess.TimeoutExpired:
        hooks.fail_and_exit(
            host=host, op=OP, err=Exception("pdftotext timed out after 60s"),
            err_class="timeout", cmd=" ".join(cmd),
        )
    if r.returncode != 0:
        hooks.fail_and_exit(
            host=host, op=OP, err=Exception(r.stderr.strip() or "pdftotext failed"),
            stderr=r.stderr,
            cmd=" ".join(cmd), exit=1,
        )
    sys.stdout.write(r.stdout)


def _extract_layout(path: Path, first: int | None, last: int | None) -> None:
    try:
        import pdfplumber
    except ImportError:
        hooks.fail_and_exit(
            host=None, op=OP,
            err=Exception("pdfplumber not installed. Install: pip install pdfplumber"),
            err_class="missing_dep", exit=2,
            cmd="pdf.py text --layout",
        )
    try:
        with pdfplumber.open(path) as pdf:
            n = len(pdf.pages)
            lo = max(1, first or 1)
            hi = min(n, last or n)
            for i in range(lo - 1, hi):
                page = pdf.pages[i]
                text = page.extract_text(layout=True) or ""
                if hi - lo > 0:
                    print(f"\n=== Page {i + 1} ===")
                print(text)
    except Exception as e:
        hooks.fail_and_exit(
            host=None, op=OP, err=e,
            cmd=f"pdf.py text --layout {path}",
        )


# ── metadata ────────────────────────────────────────────────────────────────

def cmd_meta(args: argparse.Namespace) -> None:
    path, src_url, is_temp = _resolve_input(args.input)
    host = hooks.extract_host(src_url) if src_url else None
    try:
        meta = _meta_via_pdfinfo(path, host) or _meta_via_pypdf(path, host)
        if not meta:
            hooks.fail_and_exit(
                host=host, op=OP,
                err=Exception(
                    "Could not extract metadata. Install one of:\n"
                    "  - poppler-utils (provides `pdfinfo`)\n"
                    "  - pypdf (`pip install pypdf`)"
                ),
                err_class="missing_dep", exit=2,
                cmd="pdf.py meta",
            )
        if args.json:
            print(json.dumps(meta, indent=2, default=str))
        else:
            for k, v in meta.items():
                if v in (None, ""):
                    continue
                print(f"{k}: {v}")
    finally:
        if is_temp:
            path.unlink(missing_ok=True)


def _meta_via_pdfinfo(path: Path, host: str | None) -> dict | None:
    if not shutil.which("pdfinfo"):
        return None
    try:
        r = subprocess.run(["pdfinfo", str(path)], capture_output=True, text=True, timeout=30)
    except subprocess.TimeoutExpired:
        hooks.fail_and_exit(host=host, op=OP, err=Exception("pdfinfo timed out"),
                            err_class="timeout", cmd=f"pdfinfo {path}")
    if r.returncode != 0:
        return None
    out: dict[str, str] = {}
    for line in r.stdout.splitlines():
        if ":" in line:
            k, v = line.split(":", 1)
            out[k.strip().lower().replace(" ", "_")] = v.strip()
    return out


def _meta_via_pypdf(path: Path, host: str | None) -> dict | None:
    try:
        import pypdf
    except ImportError:
        return None
    try:
        reader = pypdf.PdfReader(str(path))
        info = reader.metadata or {}
        out = {
            "pages": len(reader.pages),
            "title": info.get("/Title"),
            "author": info.get("/Author"),
            "subject": info.get("/Subject"),
            "creator": info.get("/Creator"),
            "producer": info.get("/Producer"),
            "creation_date": info.get("/CreationDate"),
            "mod_date": info.get("/ModDate"),
        }
        return out
    except Exception as e:
        hooks.fail_and_exit(host=host, op=OP, err=e, cmd=f"pypdf {path}")


# ── page count / dimensions ─────────────────────────────────────────────────

def cmd_pages(args: argparse.Namespace) -> None:
    path, src_url, is_temp = _resolve_input(args.input)
    host = hooks.extract_host(src_url) if src_url else None
    try:
        meta = _meta_via_pdfinfo(path, host) or _meta_via_pypdf(path, host) or {}
        n = meta.get("pages")
        size = meta.get("page_size") or meta.get("file_size")
        if n is not None:
            print(f"Pages: {n}")
        if size:
            print(f"Page size: {size}")
        if not n and not size:
            hooks.fail_and_exit(
                host=host, op=OP,
                err=Exception("Could not determine page count. Install poppler-utils or pypdf."),
                err_class="missing_dep", exit=2,
                cmd="pdf.py pages",
            )
    finally:
        if is_temp:
            path.unlink(missing_ok=True)


# ── main ────────────────────────────────────────────────────────────────────

def main() -> None:
    parser = argparse.ArgumentParser(
        description="Extract text and metadata from PDFs (local or remote)."
    )
    sub = parser.add_subparsers(dest="command")

    sp = sub.add_parser("text", help="Extract text")
    sp.add_argument("input", help="PDF path or http(s) URL")
    sp.add_argument("--pages", help="Page range, e.g. '1-5', '3', '-10', '5-'")
    sp.add_argument("--layout", action="store_true",
                    help="Layout-aware extraction (requires pdfplumber)")

    mp = sub.add_parser("meta", help="Show metadata")
    mp.add_argument("input", help="PDF path or http(s) URL")
    mp.add_argument("--json", action="store_true", help="Emit JSON")

    pp = sub.add_parser("pages", help="Show page count and dimensions")
    pp.add_argument("input", help="PDF path or http(s) URL")

    args = parser.parse_args()
    if not args.command:
        parser.print_help()
        sys.exit(1)

    # PRE — recall by host (for remote PDFs) or general op
    host_for_recall = hooks.extract_host(args.input) if _is_url(args.input) else None
    hooks.recall_and_emit(
        f"pdf {args.command}: {args.input[:60]}",
        host=host_for_recall, op=OP,
    )

    try:
        if args.command == "text":
            cmd_text(args)
        elif args.command == "meta":
            cmd_meta(args)
        elif args.command == "pages":
            cmd_pages(args)
    except SystemExit:
        raise
    except KeyboardInterrupt:
        sys.exit(130)
    except Exception as e:
        hooks.fail_and_exit(
            host=host_for_recall, op=OP, err=e,
            cmd=f"pdf.py {args.command} {args.input}",
            args={"command": args.command, "input": args.input[:200]},
        )


if __name__ == "__main__":
    main()
