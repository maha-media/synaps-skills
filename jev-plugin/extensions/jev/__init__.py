"""jev — Synaps CLI extension package.

Modules:
  client    HTTP client + session stats
  guard     before_tool_call safety gate (fail-closed)
  router    subagent_start auto-fill of role / write_policy / model (fail-open)
  compress  after_tool_call output relevance compression (opt-in, fail-open)
  tools     jev_decide / jev_select / jev_status model-callable tools
  audit     counters + JSONL audit trail
"""
