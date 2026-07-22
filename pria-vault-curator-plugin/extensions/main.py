#!/usr/bin/env python3
"""Synaps protocol-v2 process extension for Pria vault curation."""
import json
import struct
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from vault_curator.client import GatewayError, PriaGatewayClient
from vault_curator.tools import TOOL_SUBJECTS, TOOL_SPECS, ValidationError, validate_input


def read_frame(stream):
    headers = {}
    while True:
        line = stream.readline()
        if not line:
            return None
        if line in (b"\r\n", b"\n"):
            break
        key, value = line.decode("ascii").split(":", 1)
        headers[key.lower()] = value.strip()
    return json.loads(stream.read(int(headers["content-length"])))


def write_frame(stream, req_id, *, result=None, error=None):
    message = {"jsonrpc": "2.0", "id": req_id}
    message["error" if error else "result"] = error or result
    body = json.dumps(message, separators=(",", ":")).encode()
    stream.write(f"Content-Length: {len(body)}\r\n\r\n".encode() + body); stream.flush()


def main():
    client = None
    while (req := read_frame(sys.stdin.buffer)) is not None:
        if "id" not in req:
            continue
        try:
            method, params = req.get("method"), req.get("params") or {}
            if method == "initialize":
                cfg = params.get("config") or {}
                client = PriaGatewayClient(cfg.get("pria_base_url"), cfg.get("pria_agent_tool_token"))
                result = {"protocol_version": 1, "capabilities": {"tools": TOOL_SPECS}}
            elif method == "tool.call":
                name = params.get("name")
                if name not in TOOL_SUBJECTS: raise ValueError(f"unknown tool: {name}")
                if client is None: raise RuntimeError("extension is not initialized")
                arguments = params.get("input", {})
                validate_input(name, arguments)
                result = client.call(TOOL_SUBJECTS[name], arguments)
            elif method == "shutdown":
                write_frame(sys.stdout.buffer, req["id"], result=None); break
            else: raise ValueError(f"unknown method: {method}")
            write_frame(sys.stdout.buffer, req["id"], result=result)
        except ValidationError as exc:
            write_frame(sys.stdout.buffer, req["id"], error={"code": -32602, "message": str(exc)})
        except GatewayError as exc:
            write_frame(sys.stdout.buffer, req["id"], error={"code": -32010, "message": "gateway request failed", "data": exc.as_dict()})
        except (ValueError, RuntimeError) as exc:
            write_frame(sys.stdout.buffer, req["id"], error={"code": -32602, "message": str(exc)})
        except Exception:
            write_frame(sys.stdout.buffer, req["id"], error={"code": -32603, "message": "internal extension error"})

if __name__ == "__main__": main()
