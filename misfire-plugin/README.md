# misfire

Synaps CLI plugin that adds a **`misfire_diagnose`** tool — an educational
misconception diagnoser that reverse-engineers *why* a student gave a wrong
answer, not just *that* they were wrong.

Powered by Groq `llama-3.3-70b-versatile` with JSON-mode + a self-verification
pass that confirms the named misconception actually reproduces the student's
answer. Degrades gracefully to **offline proof mode** when no LLM key is
present, so the extension can be staged and verified without credentials.

## Installed capability

### Tool: `misfire_diagnose`

```text
misfire:misfire_diagnose
```

Input schema:

```json
{
  "question":        "(required) The problem/question as posed.",
  "student_answer":  "(required) The student's verbatim wrong answer.",
  "expected_answer": "(optional) The correct answer / rubric.",
  "subject":         "(optional) Domain e.g. 'orgchem', 'calc1', 'stats'.",
  "student_work":    "(optional) Any shown steps."
}
```

Returns a structured diagnosis:

```
MISCONCEPTION: <named misconception>

why they think it:
  <reconstructed reasoning that produces the wrong answer>

correct principle:
  <what actually applies here>

remediation:
  contrast case: <a minimal example that exposes the break>
  probe question: <follow-up to confirm the fix landed>

--- STRUCTURED ---
{ "misconception": ..., "why_they_think_it": ..., ... }
```

## Install

Install via Synaps `/plugins` marketplace or copy the bundle into
`~/.synaps-cli/plugins/misfire/`. No build step required.

```
~/.synaps-cli/plugins/misfire/
├── .synaps-plugin/plugin.json
└── extensions/main.py
```

## LLM key resolution (in priority order)

1. `MISFIRE_LLM_KEY` environment variable (guest-agent-injectable, scoped)
2. `provider.groq = <key>` line in `~/.synaps-cli/config`
3. *(no key)* → offline proof mode: echoes inputs, confirms the extension is
   staged and reachable without any LLM credential

Force offline mode explicitly by setting `MISFIRE_OFFLINE=1`.

## Requirements

- Python 3 (stdlib: `json`, `urllib.request`, `re`, `ssl`)
- Internet access to `api.groq.com` for live diagnosis (not needed in offline mode)
- A Groq API key (free tier sufficient) for live diagnosis

## Protocol

Content-Length-framed JSON-RPC over stdio (protocol version 1).
Responds to `initialize`, `tool.call`, `hook.handle`, and `shutdown`.

## Safety

No disk writes. Sends the question + student answer to Groq's API; no other
data is transmitted. Offline mode involves zero network I/O.
