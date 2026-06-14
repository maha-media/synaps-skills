"""Tool-policy gating (B3).

HARD STOP HS-1 (CONFIRMED): HookKind is a CLOSED enum
(crates/agent-engine/src/extensions/hooks/events.rs:21-40 — "The set is
intentionally closed; new kinds are added via a breaking version bump"). There
are NO dedicated before_file_write / before_credential_request /
before_subagent_spawn / before_network_tool / on_session_close hook kinds.

Mitigation (spec-sanctioned, §9.2): map every §9.2 decision point onto the
existing `before_tool_call` hook with per-tool filters. Verified tool names:
  - shell            -> "bash"
  - subagent spawn   -> "subagent"  (tools/subagent/oneshot.rs::name() == "subagent")
  - file-write       -> "write" / "edit"
  - credential       -> "request_credential" (this plugin's own tool, B5)

before_tool_call results allowed by the runtime: continue | block | confirm |
modify (events.rs:78). after_tool_call: continue only.

Policy doc shape (docs/contract.md §3):
  {
    "version": 1,
    "default": "allow",
    "rules": [
      {"tool": "bash", "input_contains": "rm -rf /", "decision": "block", "reason": "..."},
      {"tool": "subagent", "decision": "confirm", "message": "..."},
      {"tool": "write", "path_outside_instance": true, "decision": "block", "reason": "cross_instance_write"},
      ...
    ]
  }
"""
import json

# Tool name groupings for risk classification / default policy.
SHELL_TOOLS = {"bash", "shell", "sh"}
WRITE_TOOLS = {"write", "edit", "str_replace", "create_file", "apply_patch"}
SUBAGENT_TOOLS = {"subagent"}
CREDENTIAL_TOOLS = {"request_credential"}
# Tools that touch a filesystem path (for cross-instance checks).
PATH_KEYS = ("path", "file_path", "filename", "target", "file")


def _input_str(tool_input) -> str:
    if isinstance(tool_input, str):
        return tool_input
    try:
        return json.dumps(tool_input or {}, ensure_ascii=False)
    except (TypeError, ValueError):
        return str(tool_input)


def _extract_path(tool_input):
    if not isinstance(tool_input, dict):
        return None
    for key in PATH_KEYS:
        val = tool_input.get(key)
        if isinstance(val, str) and val:
            return val
    return None


def instance_root(ctx) -> str:
    """Allowed workspace subtree for the active instance (spec §4.3)."""
    account_slug = ctx.get("account_slug")
    instance_slug = ctx.get("instance_slug")
    if account_slug and instance_slug:
        return f"/srv/accounts/{account_slug}/instances/{instance_slug}"
    return None


def home_root(ctx) -> str:
    user = ctx.get("linux_username")
    return f"/home/{user}" if user else None


def is_path_outside_instance(path: str, ctx) -> bool:
    """True if an absolute path escapes both the instance subtree and the user's home."""
    if not path or not path.startswith("/"):
        return False  # relative paths resolve under cwd (assumed in-workspace)
    # Normalize without touching the filesystem.
    import posixpath
    norm = posixpath.normpath(path)
    roots = [r for r in (instance_root(ctx), home_root(ctx)) if r]
    if not roots:
        return False  # no context -> can't prove escape (handled by default policy)
    return not any(norm == r or norm.startswith(r + "/") for r in roots)


class PolicyEngine:
    def __init__(self, ctx):
        self.ctx = ctx

    def _policy(self):
        pol = self.ctx.get("policy")
        if isinstance(pol, dict):
            return pol
        return {"version": 1, "default": "allow", "rules": []}

    def _rule_matches(self, rule, tool_name, tool_input):
        if rule.get("tool") not in (None, tool_name):
            return False
        ic = rule.get("input_contains")
        if ic is not None and ic not in _input_str(tool_input):
            return False
        if rule.get("path_outside_instance"):
            path = _extract_path(tool_input)
            if not (path and is_path_outside_instance(path, self.ctx)):
                return False
        return True

    def decide(self, tool_name: str, tool_input) -> dict:
        """Return a HookResult dict: continue|block|confirm|modify.

        Resolution order:
          1. explicit policy rules (first match wins)
          2. built-in cross-instance write guard (block)
          3. built-in defaults per tool class
          4. policy `default` (allow/deny) -> continue/block
          5. fail-closed for high-risk tools when context is missing
        """
        pol = self._policy()

        # 1. explicit rules
        for rule in pol.get("rules", []):
            if self._rule_matches(rule, tool_name, tool_input):
                return self._as_result(rule)

        # 2. built-in cross-instance / out-of-home write guard
        if tool_name in WRITE_TOOLS:
            path = _extract_path(tool_input)
            if path and self.ctx.resolved and is_path_outside_instance(path, self.ctx):
                return {"action": "block",
                        "reason": "cross_instance_write: write escapes the instance workspace / user home"}

        # 5. fail-closed when context is missing for high-risk tools
        high_risk = (tool_name in SHELL_TOOLS or tool_name in WRITE_TOOLS
                     or tool_name in SUBAGENT_TOOLS)
        if not self.ctx.resolved and high_risk:
            return {"action": "block",
                    "reason": "fail_closed: no session context resolved for high-risk tool"}

        # 4. policy default
        if pol.get("default") == "deny" and tool_name not in CREDENTIAL_TOOLS:
            return {"action": "block", "reason": "policy_default_deny"}

        return {"action": "continue"}

    @staticmethod
    def _as_result(rule) -> dict:
        decision = rule.get("decision", "allow")
        if decision in ("allow", "continue"):
            return {"action": "continue"}
        if decision == "block":
            return {"action": "block",
                    "reason": rule.get("reason") or "blocked by policy"}
        if decision == "confirm":
            return {"action": "confirm",
                    "message": rule.get("message") or "Confirmation required by policy"}
        if decision == "modify":
            return {"action": "modify", "input": rule.get("modify") or {}}
        return {"action": "continue"}

    def classify_kind(self, decision_action: str) -> str:
        return {
            "block": "tool.call.blocked",
            "confirm": "tool.call.confirm_required",
            "modify": "tool.call.modified",
        }.get(decision_action, "tool.call.started")
