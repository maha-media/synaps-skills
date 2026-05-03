# Language templates

`plugin-maker` discovers extension and sidecar languages from directories:

```text
templates/extension/<lang>/lang.json
templates/sidecar/<lang>/lang.json
```

`lang.json` fields:

- `language`: display id.
- `surface`: `extension` or `sidecar`.
- `description`: one-line catalog text.
- `requires`: commands used to run/check generated code.
- `template`: template file relative to the language directory.
- `output`: generated file path under the plugin root. Supports `${NAME}`.
- `command`: manifest command. Supports `${NAME}`.
- `args`: extension manifest args. Supports `${NAME}` and `${OUTPUT}`.
- `executable`: whether the generated output is chmod `+x`.
- `syntax_check`: optional command template used by validators.

Extensions must use JSON-RPC 2.0 with `Content-Length` framing. Sidecars use
line-delimited JSON.
