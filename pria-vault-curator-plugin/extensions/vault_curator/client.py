"""Minimal Pria agent-tool HTTP gateway (standard library only)."""
import json
import os
from urllib import error, parse, request

REQUEST_TIMEOUT_SECONDS = 15
MAX_RESPONSE_BYTES = 2 * 1024 * 1024


class GatewayError(RuntimeError):
    def __init__(self, code, message, *, status=None):
        super().__init__(message)
        self.code, self.status = code, status

    def as_dict(self):
        data = {"code": self.code, "message": str(self)}
        if self.status is not None:
            data["status"] = self.status
        return data


class PriaGatewayClient:
    def __init__(self, base_url, *, opener=request.urlopen):
        if not isinstance(base_url, str) or not base_url.strip():
            raise ValueError("pria_base_url is required")
        parsed = parse.urlsplit(base_url.strip())
        if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password:
            raise ValueError("pria_base_url must be an HTTPS origin without credentials")
        if parsed.path not in ("", "/") or parsed.query or parsed.fragment:
            raise ValueError("pria_base_url must be an origin (no path, query, or fragment)")
        self.base_url = parse.urlunsplit((parsed.scheme, parsed.netloc, "", "", ""))
        self.token = os.environ.get("PRIA_AGENT_TOOL_TOKEN", "")
        if not self.token:
            raise ValueError("PRIA_AGENT_TOOL_TOKEN is required")
        self.opener = opener

    def call(self, route, payload):
        if not isinstance(route, str) or not route.startswith("/") or route.startswith("//"):
            raise ValueError("route must be a gateway-relative path")
        body = json.dumps(payload, separators=(",", ":")).encode()
        req = request.Request(self.base_url + route, data=body, method="POST", headers={
            "Authorization": "Bearer " + self.token, "Content-Type": "application/json",
            "Accept": "application/json",
        })
        try:
            with self.opener(req, timeout=REQUEST_TIMEOUT_SECONDS) as response:
                raw = response.read(MAX_RESPONSE_BYTES + 1)
        except error.HTTPError as exc:
            # Do not relay upstream bodies: they can contain secrets or implementation detail.
            raise GatewayError("upstream_http_error", "Pria gateway rejected the request", status=exc.code) from exc
        except (error.URLError, TimeoutError) as exc:
            raise GatewayError("upstream_unavailable", "Pria gateway is unavailable") from exc
        if len(raw) > MAX_RESPONSE_BYTES:
            raise GatewayError("response_too_large", "Pria gateway response exceeded the size limit")
        try:
            value = json.loads(raw)
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise GatewayError("invalid_upstream_response", "Pria gateway returned invalid JSON") from exc
        if not isinstance(value, (dict, list)):
            raise GatewayError("invalid_upstream_response", "Pria gateway returned an invalid response shape")
        return value
