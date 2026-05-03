# Synaps extension protocol v1

Extensions speak JSON-RPC 2.0 over stdio using LSP-style framing:

```text
Content-Length: <utf8-byte-count>\r\n
\r\n
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{...}}
```

Hooks are delivered through one method, `hook.handle`, with `params.kind`
set to the hook kind (`on_session_start`, `before_tool_call`, etc.).
