"""Credential-broker tool integration (B5).

Registers a `request_credential` tool (manifest permission `tools.register`) that
calls the Pria credential broker (spec §6.4 / §9.4, A12) to obtain a short-lived,
session-bound token scoped to {account, instance, user, session, tool/provider,
action}. NO static secrets are read from disk.

Broker base URL resolution (context first, then config):
  context.credential_broker_url  ->  config.credential_broker_url

Issue request:
  POST {broker}/internal/credentials/issue
  Authorization: Bearer <ingest_token-or-session-token>   (best-effort)
  { "account_id", "instance_id", "user_id", "session_id",
    "provider", "scope", "action", "ttl_seconds" }

The tool returns the broker's scoped token to the agent; issuance/denial is
audited via the shared AuditSink (B4). Uses stdlib urllib only.
"""
import json
import urllib.error
import urllib.request

DEFAULT_TIMEOUT = 5.0

TOOL_NAME = "request_credential"
TOOL_SPEC = {
    "name": TOOL_NAME,
    "description": (
        "Request a short-lived, session-scoped credential from the Pria "
        "credential broker (e.g. a Slack token scoped to a channel/action). "
        "Never returns or expects a long-lived secret."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "provider": {"type": "string",
                         "description": "Credential provider, e.g. 'slack'."},
            "scope": {"type": "string",
                      "description": "Provider-specific scope, e.g. a channel or resource."},
            "action": {"type": "string",
                       "description": "Intended action, e.g. 'post_message'."},
            "ttl_seconds": {"type": "integer",
                            "description": "Requested lifetime (broker may clamp)."},
        },
        "required": ["provider", "action"],
    },
}


class CredentialBroker:
    def __init__(self, ctx, config=None, audit=None, timeout=DEFAULT_TIMEOUT, opener=None):
        self.ctx = ctx
        self.config = config or {}
        self.audit = audit
        self.timeout = timeout
        self._opener = opener

    def base_url(self):
        return (self.ctx.get("credential_broker_url")
                or self.config.get("credential_broker_url"))

    def _token(self):
        # Best-effort session/ingest bearer for broker auth.
        return self.ctx.get("ingest_token") or self.config.get("ingest_token")

    def issue(self, tool_input: dict) -> dict:
        provider = (tool_input or {}).get("provider")
        action = (tool_input or {}).get("action")
        if not provider or not action:
            self._audit("credential.denied", provider, action,
                        reason="missing provider/action")
            return {"ok": False, "error": "provider and action are required"}

        base = self.base_url()
        if not base:
            self._audit("credential.denied", provider, action,
                        reason="broker not configured")
            return {"ok": False, "error": "credential broker not configured"}

        body = {
            "account_id": self.ctx.get("account_id"),
            "instance_id": self.ctx.get("instance_id"),
            "user_id": self.ctx.get("user_id"),
            "session_id": self.ctx.get("session_id"),
            "provider": provider,
            "scope": (tool_input or {}).get("scope"),
            "action": action,
            "ttl_seconds": (tool_input or {}).get("ttl_seconds"),
        }
        try:
            issued = self._post(base.rstrip("/") + "/internal/credentials/issue", body)
        except (urllib.error.URLError, OSError, ValueError) as exc:
            self._audit("credential.denied", provider, action, reason=str(exc))
            return {"ok": False, "error": f"broker request failed: {exc}"}

        self._audit("credential.issued", provider, action,
                    extra={"credential_id": issued.get("credential_id"),
                           "expires_at": issued.get("expires_at")})
        # Return only the short-lived token + metadata; never echo a static secret.
        return {
            "ok": True,
            "provider": provider,
            "token": issued.get("token"),
            "expires_at": issued.get("expires_at"),
            "credential_id": issued.get("credential_id"),
            "scope": issued.get("scope") or body["scope"],
        }

    def _post(self, url, body):
        data = json.dumps({k: v for k, v in body.items() if v is not None},
                          ensure_ascii=False).encode("utf-8")
        req = urllib.request.Request(url, data=data, method="POST")
        req.add_header("Content-Type", "application/json")
        token = self._token()
        if token:
            req.add_header("Authorization", f"Bearer {token}")
        opener = self._opener or urllib.request.urlopen
        resp = opener(req, timeout=self.timeout)
        status = getattr(resp, "status", None) or 200
        raw = resp.read() if hasattr(resp, "read") else b"{}"
        close = getattr(resp, "close", None)
        if callable(close):
            close()
        if not (200 <= int(status) < 300):
            raise ValueError(f"broker status {status}")
        return json.loads(raw.decode("utf-8")) if raw else {}

    def _audit(self, kind, provider, action, reason=None, extra=None):
        if self.audit is None:
            return
        fields = {"provider": provider, "action": action}
        if reason:
            fields["reason"] = reason
        if extra:
            fields.update(extra)
        self.audit.emit(kind, fields)
