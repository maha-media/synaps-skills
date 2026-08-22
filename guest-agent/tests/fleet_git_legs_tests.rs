//! F7 — guest git legs + guest-local workspace write (charter
//! /tmp/synaps-skills-f7-charter.md; VM-FLEET W5 plan §2.6, R-F7-1..3).
//!
//! Born-RED: the ws-token parse, the git legs, the wire verbs, and the
//! workspace lifecycle do not exist yet — these rows fail at birth.
//!
//! Run: cargo test --test fleet_git_legs_tests

use pria_guest_agent::fleet::parse_fleet_directive;

// ── F7-P: ws-token parse matrix ─────────────────────────────────────────────
//
// The fleet line grows an OPTIONAL 4th token `ws:<slug>` (slug charset
// `^[a-z0-9][a-z0-9_-]*$` — byte-twin of Pria's utils WORKSPACE_SLUG_RE).
// Absent ⇒ workspace-less binding (today's F6 behavior). Present+valid ⇒
// workspace-bound. Malformed ⇒ NO fleet binding at all (fail-closed).

#[test]
fn f7p_absent_ws_token_parses_workspace_less() {
    let d = parse_fleet_directive("set_task vault-curator@1\ndigest sha256:ab\nfleet fj-a 1")
        .expect("3-token fleet line still binds");
    assert_eq!(d.handle_id, "fj-a");
    assert_eq!(d.generation, 1);
    assert_eq!(d.workspace_slug(), None, "no ws token ⇒ workspace-less");
}

#[test]
fn f7p_valid_ws_token_binds_the_slug() {
    let d = parse_fleet_directive("set_task vault-curator@1\nfleet fj-a 1 ws:brandsite")
        .expect("ws-bound fleet line binds");
    assert_eq!(d.handle_id, "fj-a");
    assert_eq!(d.generation, 1);
    assert_eq!(d.workspace_slug(), Some("brandsite".to_string()));
}

#[test]
fn f7p_slug_charset_matrix() {
    // Valid slugs (lowercase alnum start, then alnum/_/-).
    for slug in ["a", "brandsite", "my-site", "my_site", "s1", "a1-b_c"] {
        let text = format!("set_task t@1\nfleet fj-a 1 ws:{slug}");
        let d = parse_fleet_directive(&text).unwrap_or_else(|| panic!("slug {slug} should bind"));
        assert_eq!(d.workspace_slug().as_deref(), Some(slug));
    }
}

#[test]
fn f7p_malformed_ws_token_fails_closed_no_binding() {
    // Each of these must yield NO fleet directive at all (fail-closed), never
    // a workspace-less binding smuggled out of a malformed token.
    for text in [
        "set_task t@1\nfleet fj-a 1 ws:",                 // empty slug
        "set_task t@1\nfleet fj-a 1 ws:Upper",            // uppercase
        "set_task t@1\nfleet fj-a 1 ws:-leading",         // leading dash
        "set_task t@1\nfleet fj-a 1 ws:_leading",         // leading underscore
        "set_task t@1\nfleet fj-a 1 ws:has space",        // embedded space
        "set_task t@1\nfleet fj-a 1 ws:dot.dot",          // dot
        "set_task t@1\nfleet fj-a 1 ws:slash/x",          // slash (traversal)
        "set_task t@1\nfleet fj-a 1 ws:..",               // traversal
        "set_task t@1\nfleet fj-a 1 ws:a\u{0}b",          // NUL
        "set_task t@1\nfleet fj-a 1 wrong:brandsite",     // wrong token key
        "set_task t@1\nfleet fj-a 1 ws:a ws:b",           // two ws tokens
        "set_task t@1\nfleet fj-a 1 ws:a extra",          // trailing junk
    ] {
        assert_eq!(
            parse_fleet_directive(text),
            None,
            "malformed ws token must yield NO binding: {text:?}"
        );
    }
}

#[test]
fn f7p_envelope_borne_ws_token_parses() {
    // Live prompt-envelope law: the wire text rides inside a JSON-RPC prompt
    // envelope's `message`. The parse is envelope-agnostic (operates on the
    // extracted message) — the classify_send path extracts it first.
    let d = parse_fleet_directive("set_task t@1\nfleet fj-env 2 ws:site-x")
        .expect("envelope message parses");
    assert_eq!(d.workspace_slug().as_deref(), Some("site-x"));
}
