#!/usr/bin/env bash
# scripts/setup.sh — configure the jev plugin from a shell.
#
#   setup.sh --key apikey_…     validate the key live, save it, done (running sessions pick it up within 5 s)
#   setup.sh --check            show where a key is found, and whether it works
#   setup.sh --unset            remove the saved key from the plugin config store
#
# The key is stored in  $SYNAPS_BASE_DIR/plugins/jev/config  (default ~/.synaps-cli/plugins/jev/config)
# as `api_key = …`, mode 600 — the same place `/jev key …` writes and the runtime reads at initialize.
#
# Inside synaps you can do the same with:   /jev key apikey_…

set -euo pipefail

BASE="${SYNAPS_BASE_DIR:-$HOME/.synaps-cli}"
STORE="$BASE/plugins/jev/config"
LEGACY="$BASE/config"
API="https://api.typesafe.ai/v1/systemone"

green()  { printf '\033[32m✓ %s\033[0m\n' "$*"; }
red()    { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; }
yellow() { printf '\033[33m! %s\033[0m\n' "$*"; }

usage() { sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit "${1:-0}"; }

read_kv() {  # file key
  [[ -f "$1" ]] || return 1
  awk -F'=' -v k="$2" '
    /^[[:space:]]*#/ || !/=/ { next }
    { key=$1; sub(/^[[:space:]]+|[[:space:]]+$/, "", key) }
    key == k { v=substr($0, index($0,"=")+1); gsub(/^[[:space:]]+|[[:space:]]+$/, "", v); gsub(/^"|"$/, "", v); print v; exit }
  ' "$1"
}

discover() {  # prints "key<TAB>source" or nothing
  if [[ -n "${SYNAPS_EXTENSION_JEV_API_KEY:-}" ]]; then printf '%s\tenv:SYNAPS_EXTENSION_JEV_API_KEY\n' "$SYNAPS_EXTENSION_JEV_API_KEY"; return; fi
  if [[ -n "${TYPESAFE_API_KEY:-}" ]];            then printf '%s\tenv:TYPESAFE_API_KEY\n' "$TYPESAFE_API_KEY"; return; fi
  local v
  if v="$(read_kv "$STORE" api_key)" && [[ -n "$v" ]]; then printf '%s\tfile:%s\n' "$v" "$STORE"; return; fi
  if v="$(read_kv "$LEGACY" extension.jev.api_key)" && [[ -n "$v" ]]; then printf '%s\tfile:%s (extension.jev.api_key)\n' "$v" "$LEGACY"; return; fi
}

redact() { local k="$1"; (( ${#k} > 18 )) && printf '%s…%s' "${k:0:10}" "${k: -4}" || printf '(set)'; }

probe() {  # key → prints "ms model" on success, returns 1 on failure
  command -v curl >/dev/null || { red "curl is required"; return 1; }
  local t0 t1 body code
  t0=${EPOCHREALTIME/./}
  body="$(curl -sS -m 8 -w '\n%{http_code}' -X POST "$API" \
      -H "Authorization: Bearer $1" -H "Content-Type: application/json" \
      -d '{"state":{"note":"jev plugin key check"},"model":"jev-latest","questions":{"ok":{"type":"noul","instructions":"Is `note` a self-test?"}}}' 2>&1)" || { red "network: $body"; return 1; }
  t1=${EPOCHREALTIME/./}
  code="${body##*$'\n'}"; body="${body%$'\n'*}"
  if [[ "$code" != "200" ]]; then red "HTTP $code: ${body:0:200}"; return 1; fi
  printf '%s %s\n' "$(( (t1 - t0) / 1000 ))" "$(printf '%s' "$body" | sed -n 's/.*"model":"\([^"]*\)".*/\1/p')"
}

save() {  # key
  mkdir -p "$(dirname "$STORE")"
  local tmp="$STORE.tmp"
  if [[ -f "$STORE" ]] && grep -Eq '^[[:space:]]*api_key[[:space:]]*=' "$STORE"; then
    sed -E "s|^([[:space:]]*api_key[[:space:]]*=).*|\1 $1|" "$STORE" > "$tmp"
  else
    { [[ -f "$STORE" ]] && cat "$STORE"; printf 'api_key = %s\n' "$1"; } > "$tmp"
  fi
  chmod 600 "$tmp"; mv -f "$tmp" "$STORE"; chmod 600 "$STORE"
}

warn_if_symlinked_into_repo() {
  local dir; dir="$(dirname "$STORE")"
  if [[ -L "$dir" ]]; then
    yellow "$dir is a symlink → $(readlink -f "$dir"); the key file lands inside that tree (it is git-ignored as /config)."
  fi
}

case "${1:-}" in
  --key)
    key="${2:-}"
    [[ "$key" =~ ^apikey_[A-Za-z0-9_]{20,}$ ]] || { red "expected an apikey_… value"; usage 2; }
    if out="$(probe "$key")"; then
      green "key accepted by ${out#* } in ${out%% *} ms"
    else
      red "key rejected — nothing saved"; exit 1
    fi
    warn_if_symlinked_into_repo
    save "$key"
    green "saved to $STORE (mode 600)"
    green "running synaps sessions pick it up within 5 s; new sessions read it at start"
    ;;
  --check)
    if found="$(discover)" && [[ -n "$found" ]]; then
      key="${found%%$'\t'*}"; src="${found#*$'\t'}"
      echo "key:   $(redact "$key")  ($src)"
      if out="$(probe "$key")"; then green "works: ${out#* } answered in ${out%% *} ms"; else red "key present but rejected"; exit 1; fi
    else
      yellow "no key found. Set one with:  $0 --key apikey_…   or   /jev key apikey_…  inside synaps"
      echo "store: $STORE"; exit 1
    fi
    ;;
  --unset)
    if [[ -f "$STORE" ]]; then
      tmp="$STORE.tmp"; grep -Ev '^[[:space:]]*api_key[[:space:]]*=' "$STORE" > "$tmp" || true
      chmod 600 "$tmp"; mv -f "$tmp" "$STORE"; green "removed api_key from $STORE"
    else
      yellow "nothing to remove ($STORE absent)"
    fi
    ;;
  -h|--help|"") usage 0 ;;
  *) red "unknown option: $1"; usage 2 ;;
esac
