"""finlens.scratchpad — append-only JSONL run log. Stolen from dexter.

One file per run: {timestamp}_{runid}.jsonl. Every lens result, the synthesis math,
and the final output are appended, never mutated. Free audit trail + replayable.
"""
from __future__ import annotations

import json
import os
import time
import uuid
import datetime as _dt


def _utc() -> str:
    return _dt.datetime.now(_dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


class Scratchpad:
    def __init__(self, out_dir: str, run_id: str | None = None):
        os.makedirs(out_dir, exist_ok=True)
        self.run_id = run_id or f"{time.strftime('%Y%m%d-%H%M%S')}_{uuid.uuid4().hex[:6]}"
        self.path = os.path.join(out_dir, f"{self.run_id}.jsonl")
        self._fh = open(self.path, "a", encoding="utf-8")
        self.event("run.start", {"run_id": self.run_id})

    def event(self, kind: str, data: dict) -> None:
        rec = {"ts": _utc(), "kind": kind, **data}
        self._fh.write(json.dumps(rec, default=str) + "\n")
        self._fh.flush()

    def lens_result(self, lens: str, ticker: str, output: dict | None, error: str | None = None) -> None:
        self.event("lens.result", {"lens": lens, "ticker": ticker,
                                   "output": output, "error": error})

    def close(self) -> None:
        self.event("run.end", {"run_id": self.run_id})
        try:
            self._fh.close()
        except Exception:
            pass

    def __enter__(self) -> "Scratchpad":
        return self

    def __exit__(self, *exc) -> None:
        self.close()
