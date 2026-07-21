"""Minimal Pria agent-tool HTTP gateway (standard library only)."""
import json
import os
from urllib import error, request


class GatewayError(RuntimeError):
    pass


class PriaGatewayClient:
    def __init__(self, base_url, *, opener=request.urlopen, timeout=30):
        if not isinstance(base_url, str) or not base_url.strip():
            raise ValueError("pria_base_url is required")
        self.base_url = base_url.rstrip("/")
        self.token = os.environ.get("PRIA_AGENT_TOOL_TOKEN", "")
        if not self.token:
            raise ValueError("PRIA_AGENT_TOOL_TOKEN is required")
        self.opener, self.timeout = opener, timeout

    def call(self, route, payload):
        body = json.dumps(payload, separators=(",", ":")).encode()
        req = request.Request(self.base_url + route, data=body, method="POST", headers={
            "Authorization": "Bearer " + self.token,
            "Content-Type": "application/json",
            "Accept": "application/json",
        })
        try:
            with self.opener(req, timeout=self.timeout) as response:
                raw = response.read()
        except error.HTTPError as exc:
            detail = exc.read().decode("utf-8", "replace")
            raise GatewayError(f"Pria request failed ({exc.code}): {detail}") from exc
        except error.URLError as exc:
            raise GatewayError(f"Pria request failed: {exc.reason}") from exc
        try:
            return json.loads(raw)
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise GatewayError("Pria returned an invalid JSON response") from exc
