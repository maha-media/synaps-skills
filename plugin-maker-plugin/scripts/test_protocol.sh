#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PM="$ROOT/bin/plugin-maker"
source "$ROOT/lib/languages.sh"

fail() { printf '✗ %s\n' "$*" >&2; exit 1; }
ok() { printf '✓ %s\n' "$*" >&2; }

json_frame() {
  local body="$1"
  printf 'Content-Length: %s\r\n\r\n%s' "$(printf '%s' "$body" | wc -c)" "$body"
}

assert_extension_protocol() {
  local lang="$1" tmp ext cmd out
  local -a args
  tmp="$(mktemp -d -t pm-proto-ext.XXXXXX)"
  (cd "$tmp" && "$PM" new plugin demo --extension "$lang" >/dev/null)
  ext="$tmp/demo-plugin"
  cmd="$(jq -r '.extension.command' "$ext/.synaps-plugin/plugin.json")"
  mapfile -t args < <(jq -r '.extension.args // [] | .[]' "$ext/.synaps-plugin/plugin.json")
  out="$(cd "$ext" && { json_frame '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}'; json_frame '{"jsonrpc":"2.0","id":2,"method":"hook.handle","params":{"kind":"on_session_start"}}'; json_frame '{"jsonrpc":"2.0","id":3,"method":"shutdown","params":{}}'; } | timeout 5s "$cmd" "${args[@]}" 2>/dev/null)"
  grep -q '^Content-Length: ' <<<"$out" || fail "extension $lang did not emit Content-Length frames"
  grep -q '"protocol_version":1' <<<"$out" || fail "extension $lang missing initialize protocol_version"
  grep -q '"id":2' <<<"$out" || fail "extension $lang did not answer hook.handle"
  grep -q '"id":3' <<<"$out" || fail "extension $lang did not answer shutdown"
  rm -rf "$tmp"
  ok "extension protocol: $lang"
}

assert_sidecar_protocol() {
  local lang="$1" tmp plugin cmd out
  tmp="$(mktemp -d -t pm-proto-sc.XXXXXX)"
  (cd "$tmp" && "$PM" new plugin demo --sidecar "$lang" >/dev/null)
  local plugin="$tmp/demo-plugin"
  local -a args
  cmd="$(jq -r '.provides.sidecar.command' "$plugin/.synaps-plugin/plugin.json")"
  mapfile -t args < <(jq -r '.provides.sidecar.args // [] | .[]' "$plugin/.synaps-plugin/plugin.json")
  out="$(cd "$plugin" && { printf '{"type":"init","config":{}}\n'; printf '{"type":"shutdown"}\n'; } | timeout 5s "$cmd" "${args[@]}" 2>/dev/null || true)"
  grep -q '"type"[[:space:]]*:[[:space:]]*"hello"' <<<"$out" || fail "sidecar $lang did not emit hello"
  grep -q '"protocol_version"[[:space:]]*:[[:space:]]*2' <<<"$out" || fail "sidecar $lang missing protocol_version 2"
  rm -rf "$tmp"
  ok "sidecar protocol: $lang"
}

main() {
  local lang
  while IFS= read -r lang; do
    [[ -z "$lang" ]] && continue
    if [[ "$lang" == "go" || "$lang" == "deno" ]] || ! lang_interpreter_available extension "$lang"; then
      ok "extension protocol: $lang (skipped; missing deps)"
      continue
    fi
    assert_extension_protocol "$lang"
  done < <(find "$ROOT/templates/extension" -mindepth 1 -maxdepth 1 -type d ! -name '_*' -printf '%f\n' | sort)

  while IFS= read -r lang; do
    [[ -z "$lang" ]] && continue
    if [[ "$lang" == "deno" ]] || ! lang_interpreter_available sidecar "$lang"; then
      ok "sidecar protocol: $lang (skipped; missing deps)"
      continue
    fi
    assert_sidecar_protocol "$lang"
  done < <(find "$ROOT/templates/sidecar" -mindepth 1 -maxdepth 1 -type d ! -name '_*' -printf '%f\n' | sort)
}

main "$@"
