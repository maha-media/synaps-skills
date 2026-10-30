"""secret_patterns — deterministic credential-shape scan (no model, no I/O).

Used where a bounded preview cannot cover the whole payload (send_events
bodies up to 256 KiB). Callers get *kinds* only, never the matched text, so a
hit can be reported, logged and audited without echoing the secret.

The patterns favour recall: a false positive costs one confirmation, a false
negative ships a credential to another session's transcript. A placeholder
is excluded only as a whole value (see _PLACEHOLDER), never by a prefix or by
refusing whole classes of characters, so ordinary password punctuation still
matches.

Speed matters because the host treats a slow hook (5 s) as *continue*: every
regex starts with a literal (the boundary check is a lookbehind placed after
the literal), which keeps Python's fast prefix search, and every lookahead
is bounded; case-insensitive kinds run on one lower-cased copy of the text.
A value's runs of tokens are read once (a lookahead and a backreference make
them atomic), and cheap lookaheads turn away short words before any token
is read. The suite's adversarial near misses take under 0.5 s for 32 x
256 KiB scans each (test_adversarial_near_misses_scan_fast).
"""

from __future__ import annotations

import re

# ── name = value assignments ────────────────────────────────────────────────
#
# Separator: an optional closing quote of the name, escaped at any depth of
# nested JSON text, then `:`, `=`, `:=` or `=>`. The value starts at the
# first non-space, so backtracking into the spaces fails at once instead of
# re-trying every value form.
_SEP = r"\\*[\"'`]?\s{0,8}(?::=|=>|[:=])\s{0,8}(?=\S)"

# A quote that closes the string an unquoted value sits in, after any run of
# backslashes (escaped JSON): followed by whitespace, `, ; : ) ] }` or the
# end of the text (review r4). Any other quote or backslash is part of the
# value, so `password=<NAME>"RealPass123!` and `password=ab"RealPass123!"`
# are scanned while `"cmd": "export PASSWORD=<NAME>"` is not.
_CLOSING = r"\\*[\"'`](?=[\s,;:)\]}]|$)"

# Where an unquoted placeholder ends: whitespace, list or call punctuation,
# a closing quote, or the end of the text.
_END = r"(?=[\s,;)\]}]|$|" + _CLOSING + r")"

# One token of an unquoted value: a character other than whitespace, a quote
# or a backslash; a run of backslashes not before a quote; or a quote (after
# its backslashes) that closes nothing. The value runs to whitespace or a
# closing quote, as _END reads it. The text splits into these tokens in one
# way only: the alternatives start with different characters and a run of
# backslashes is always taken whole. So a run of tokens can be read
# atomically (r6), and the quote alternatives spell out _CLOSING's followers
# instead of testing _CLOSING again.
_UTOKEN = r"(?:[^\s\"'`\\]|[\"'`](?![\s,;:)\]}]|$)|\\+(?:[\"'`](?![\s,;:)\]}]|$)|(?![\\\"'`])))"

# Placeholders: exempt only when the WHOLE value is one (review r2 R2-1).
# A template reference whose name has no other punctuation, a mask made only
# of mask characters, or a stock word, then the end of the value: the
# closing quote for a quoted value, _END for an unquoted one. Anything else
# is scanned: a placeholder with a real tail or prefix, punctuation inside
# the brackets, a path, `$VAR`, an embedded run of x or *. When in doubt the
# value counts, and a false hit costs one confirmation.
_WORD = r"[a-z0-9_.-]{1,64}"                  # the text is lower-cased first
_PLACEHOLDER_BODY = (
    # The first character of every form below (the text is lower-cased), so
    # most values fail at once (r6).
    r"(?=[<${%x*\u2022_\u2026cdehmnoprstu])(?:"
    r"<" + _WORD + r">"                       # <redacted>, <your-token-here>
    r"|\$\{" + _WORD + r"\}"                  # ${DB_PASSWORD}
    r"|\{\{" + _WORD + r"\}\}"                # {{db_password}}
    r"|%\(" + _WORD + r"\)s"                  # %(db_password)s
    r"|%" + _WORD + r"%"                      # %DB_PASSWORD%
    r"|[x*\u2022_\u2026]{1,256}"              # masks: xxxxxxxx, ********, ••••, ____, ……
    r"|(?:changeme|change_me|change-me|redacted|placeholder|example|dummy|sample|secret|password|passwd"
    r"|token|none|null|nil|undefined|hidden|masked|required|optional|string|unset|empty|todo|tbd)"
    r")"
)
_PLACEHOLDER = _PLACEHOLDER_BODY + _END

# Quoted value (review r3 B1): its extent is set by its quote layer, read
# from the run of backslashes before the opening quote (the separator ends
# at a non-backslash, so the run is always whole).
# - Even run (0, 2, ...): an unescaped quote. The value ends at the next
#   unescaped quote of the same kind; an escaped quote inside it (an odd run
#   before it) and a quote of another kind are part of the value. Tokens:
#   characters and escape pairs.
# - Odd run (1, 3, 7, ...): an escaped quote, i.e. JSON text inside a
#   string. The value ends only at the same run before the same quote; any
#   other run of backslashes with the character after it, and any unescaped
#   quote, is part of it.
_OPEN = r"(?:(?P<odd>(?:\\\\)*\\)|(?:\\\\)*)(?P<q>[\"'`])"
_CLOSE = r"(?(odd)(?P=odd))(?P=q)"
_TOKEN = (r"(?:[^\s\"'`\\]"
          r"|(?(odd)(?!" + _CLOSE + r")\\+[^\s\\]|\\[^\s])"
          r"|(?(odd)[\"'`]|(?!(?P=q))[\"'`]))")

# Where a quoted value ends (review r4 R4-1, the quoted side of the r4
# ruling): its closing quote is followed by whitespace, `, ; : ) ] }`, a
# quote that closes an enclosing string (_CLOSING), or the end of the text.
# Anything else continues the value, as in shell, where
# password="<NAME>"RealPass123! assigns <NAME>RealPass123!.
_QEND = r"(?=[\s,;:)\]}]|$|" + _CLOSING + r")"

# One reading from the opening quote decides both cases:
# - A placeholder is the whole value only when its layer's closing quote
#   follows it at once and _QEND follows that quote; otherwise the value is
#   scanned.
# - Quoted value: 8+ tokens of its first word, which runs to whitespace or
#   the value's closing quote. A mismatched quote, a different run or no
#   closing quote is read the same way.
# - Concatenation (R4-1): a first word of up to 7 tokens, then its closing
#   quote and more value. The value is the whole concatenation, quoted and
#   unquoted parts together, up to the next real boundary, read again from
#   the opening quote as the bare word it becomes (_UTOKEN runs on across
#   quotes that close nothing) and judged by the unquoted rules below. A
#   longer first word already hits as a quoted value, since the suffix keeps
#   it from being a whole placeholder.
# The first 7 tokens are read once: a lookahead and a backreference make the
# run atomic (no atomic groups before Python 3.11), so a close or an 8th
# token is tried at one place only. The empty group `quoted` marks a quoted
# hit; without it, the bare reading follows.
# Fast path (r6): a first word of up to 7 plain characters (no quote or
# backslash) is read once (`pl`). When its layer's close follows (`plc`),
# that close decides as above: a concatenation if more value follows it,
# nothing if the value ends there. Each plain character is one token and a
# shorter plain prefix is followed by a plain character, never a close, so
# this is the general reading's answer for such words.
_PLAIN = r"[^\s\"'`\\]"
_QUOTED = (r"(?=" + _OPEN + r"(?!" + _PLACEHOLDER_BODY + _CLOSE + _QEND + r")"
           r"(?=(?P<pl>" + _PLAIN + r"{0,7})(?P<plc>" + _CLOSE + r")?)"
           r"(?(plc)(?P=pl)" + _CLOSE + r"(?!" + _QEND + r")"
           r"|(?=(?P<run>" + _TOKEN + r"{0,7}))(?P=run)"
           r"(?:" + _TOKEN + r"(?P<quoted>)|" + _CLOSE + r"(?!" + _QEND + r"))))")


def _quoted_or_concatenated(bare: str) -> str:
    return _QUOTED + r"(?(quoted)|" + bare + r")"


# Unquoted value after a name that is common in prose (password, token,
# secret): 8+ tokens that look like a credential, i.e. hold a digit or a
# symbol within the value's first 64 characters (`token: expired`, `secret:
# rotating` stay quiet; `password: hunter2!x` does not). The window counts
# characters, so a run of backslashes uses it up by its length (and a
# concatenation's quotes count too). Two lookaheads read it with no repeat
# per token, which keeps a long value with a quote in it cheap (r4
# benchmark):
# - a symbol among the value's first 64 non-space characters;
# - the value reaches a symbol before it ends: runs of other characters,
#   crossing only quotes that close nothing (_NCQ, the complement of
#   _CLOSING's followers).
# The first bounds the second: whitespace cannot come before that symbol, so
# the second stops at it, or earlier at a closing quote.
# Then the 8 tokens, read atomically (r6): 7 in a lookahead, a backreference,
# and the 8th tried at one place only. Before all of it, a word of at most 7
# plain characters that ends the value (whitespace, the end, a closing
# quote) fails at once: it cannot hold 8 tokens. `run` names the group, so
# the quoted reading's bare form and the unquoted form can share a regex.
_SYMBOLS = "0-9!#$%&*+/:=?@^~|"
_SYM = "[" + _SYMBOLS + "]"
_SEG = r"[^\"'`" + _SYMBOLS + r"]*"
_NCQ = r"[\"'`](?=[^,;:)\]}])"


def _shape(run: str) -> str:
    return (r"(?!" + _PLAIN + r"{0,7}(?:\s|$|" + _CLOSING + r"))(?=\S{0,63}" + _SYM + r")"
            r"(?=(?:" + _SEG + _NCQ + r")*" + _SEG + _SYM + r")"
            r"(?=(?P<" + run + r">" + _UTOKEN + r"{0,7}))(?P=" + run + r")" + _UTOKEN)


_SHAPED = r"(?![\\\"'`])(?!" + _PLACEHOLDER + r")" + _shape("su")


# Unquoted value after a key-specific name (api_key, secret_key, access_key,
# private_key): 12+ characters, any shape, unless it is a placeholder. Every
# token holds a non-space character, so fewer than 12 of those fail at once;
# the 12 tokens are read atomically, as in _shape (r6).
def _keyed(run: str) -> str:
    return r"(?=(?P<" + run + r">" + _UTOKEN + r"{0,11}))(?P=" + run + r")" + _UTOKEN


_KEYED = r"(?=\S{12})(?![\\\"'`])(?!" + _PLACEHOLDER + r")" + _keyed("ku")


def _prose_named(*roots: str) -> tuple[str, ...]:
    return tuple(root + _SEP + r"(?:" + _quoted_or_concatenated(_shape("sc")) + r"|" + _SHAPED + r")"
                 for root in roots)


def _key_named(*roots: str) -> tuple[str, ...]:
    return tuple(root + _SEP + r"(?:" + _quoted_or_concatenated(r"(?=\S{12})" + _keyed("kc")) + r"|" + _KEYED + r")"
                 for root in roots)


# Bearer tokens: a header form with any 8+ token characters, and bare
# `bearer X` with 12+ characters holding a digit, or 20+ of any. The token
# characters exclude `<` and `$`, so `Bearer <token>` / `Bearer $TOKEN` /
# `Bearer ${TOKEN}` stay quiet.
_BEARER_CHARS = r"[a-z0-9._~+/=-]"
_BEARER_TOKEN = (r"(?:(?=" + _BEARER_CHARS + r"{0,63}[0-9])" + _BEARER_CHARS + r"{12}"
                 r"|" + _BEARER_CHARS + r"{20})")

# (kind, case_insensitive, regexes). Ordered: scan_secrets reports kinds in
# this order. Each regex has a positive fixture in tests/test_guard_parity.py,
# so dropping one goes red.
_TABLE = (
    ("private_key", False, (r"-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----",)),
    # sk-… (OpenAI/Anthropic style): 20+ characters with a digit, or an
    # unbroken 32+ alphanumeric run, so hyphenated prose
    # ("sk-learn-style-something-long") stays quiet.
    ("sk_token", False, (r"sk-(?<![A-Za-z0-9_-]sk-)(?=[A-Za-z0-9_-]{0,200}[0-9])[A-Za-z0-9_-]{20,}",
                         r"sk-(?<![A-Za-z0-9_-]sk-)[A-Za-z0-9_-]{0,40}?[A-Za-z0-9]{32}")),
    ("stripe_key", False, (r"k_live_(?<=[rs]k_live_)(?<![A-Za-z0-9_][rs]k_live_)[A-Za-z0-9]{16,}",
                           r"k_test_(?<=[rs]k_test_)(?<![A-Za-z0-9_][rs]k_test_)[A-Za-z0-9]{16,}")),
    ("github_token", False, (r"gh[pousr]_(?<![A-Za-z0-9_]gh[pousr]_)[A-Za-z0-9]{36,}",
                             r"github_pat_(?<![A-Za-z0-9_]github_pat_)[A-Za-z0-9_]{22,}")),
    ("gitlab_token", False, (r"glpat-(?<![A-Za-z0-9_-]glpat-)[A-Za-z0-9_-]{20,}",)),
    ("slack_token", False, (r"xox[abposr]-(?<![A-Za-z0-9_-]xox[abposr]-)[A-Za-z0-9-]{10,}",)),
    ("aws_access_key", False, (r"AKIA(?<![A-Z0-9]AKIA)[A-Z0-9]{16}(?![A-Z0-9])",
                               r"ASIA(?<![A-Z0-9]ASIA)[A-Z0-9]{16}(?![A-Z0-9])")),
    ("google_api_key", False, (r"AIza(?<![A-Za-z0-9_-]AIza)[0-9A-Za-z_-]{35}",)),
    ("typesafe_key", False, (r"apikey_(?<![A-Za-z0-9_]apikey_)[A-Za-z0-9]{16,}",)),
    ("jwt", False, (r"eyJ(?<![A-Za-z0-9_-]eyJ)[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}",)),
    ("bearer_token", True, (
        r"authorization(?<![a-z0-9_]authorization)[\"']?\s{0,8}[:=]\s{0,8}[\"']?bearer\s{1,16}"
        + _BEARER_CHARS + r"{8}",
        r"bearer(?<![a-z0-9_]bearer)\s{1,16}" + _BEARER_TOKEN,
    )),
    ("url_credentials", True, (r"://(?<=[a-z0-9+.-]://)[^\s/:@'\"]{1,128}:[^\s/@'\"]{3,256}@",)),
    # name = value / "name": "value". The name may end a compound: after
    # `_` or `-` (DB_PASSWORD=, x-api-key:) or, since the text is
    # lower-cased, a letter or digit (accessToken:, dbPassword=,
    # clientSecret:, googleApiKey:, oauth2token=).
    ("api_key_pair", True, _key_named(
        r"api[_-]?key",
        r"secret[_-]?key",
        r"access[_-]?key(?:[_-]?id)?",
        r"private[_-]?key",
    )),
    ("password_assignment", True, _prose_named(
        r"passw(?:or)?d",
        r"passphrase",
    )),
    ("token_assignment", True, _prose_named(r"token")),
    ("secret_assignment", True, _prose_named(r"secret")),
)

PATTERNS: tuple[tuple[str, bool, tuple[re.Pattern, ...]], ...] = tuple(
    (kind, folded, tuple(re.compile(rx) for rx in rxs)) for kind, folded, rxs in _TABLE)

KINDS = tuple(kind for kind, _, _ in PATTERNS)


def scan_secrets(text: str) -> list[str]:
    """Distinct pattern kinds found anywhere in `text`, in table order."""
    if not isinstance(text, str):
        raise TypeError("scan_secrets expects text")
    lowered = text.lower()
    return [kind for kind, folded, rxs in PATTERNS
            if any(rx.search(lowered if folded else text) for rx in rxs)]
