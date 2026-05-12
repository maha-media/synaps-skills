---
name: type-driven-design
description: Use when designing Rust APIs, protocol/config boundaries, domain models, or refactors where invariants should be encoded in types instead of comments or runtime conventions.
---

# Type-Driven Design

Represent domain ideas as types. Make invalid states hard to express, validate untrusted input once at the boundary, and keep the safe path simple at the call site.

This skill is not a license to build type machinery for its own sake. Abstract from working code and real invariants. If a type does not prevent a bug, clarify an API, or remove repeated validation, it probably is not earning its cost.

## When to Use

Use this when touching:

- Rust APIs and module boundaries
- Plugin manifests, settings, config, or protocol frames
- IDs, paths, permissions, request IDs, command names, model/provider names
- Numeric conversions, lengths, indexes, sample rates, terminal coordinates, timestamps
- Any `serde_json::Value`, raw `String`, raw integer, or untrusted filesystem/network input crossing into core logic

## Core Pattern

```text
External input -> Raw type -> Validated type -> Runtime type
```

Examples:

```rust
struct RawManifest(serde_json::Value);
struct ValidatedManifest { id: PluginId, commands: Vec<CommandSpec> }
struct LoadedPlugin { manifest: ValidatedManifest, trust: TrustDecision }
```

```rust
struct PluginId(String);
struct ProviderId(String);
struct RequestId(String);
struct SampleRateHz(u32);
struct FrameCount(usize);
```

Parse and validate at the boundary. After that, internal code should accept the validated type, not the raw representation.

## Design Checklist

Before adding or changing an API, ask:

- **Concept:** What domain concept is this value? If the name is only `String`, `usize`, or `Value`, is that hiding meaning?
- **Invariant:** What must always be true? Can the type constructor enforce it?
- **Boundary:** Where does untrusted input become trusted internal data?
- **Conversion:** Should this be `TryFrom`/`FromStr` instead of ad-hoc validation?
- **Closed set:** Should this string be an enum?
- **Numeric safety:** Are casts checked with `try_from`, `checked_*`, or explicitly justified `saturating_*`/`wrapping_*` semantics?
- **Call-site simplicity:** Does the safe API read like ordinary code?
- **Cost:** Is the new type preventing a real bug class or repeated validation?

## Rust Patterns

### Newtypes for semantic IDs

```rust
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct PluginId(String);

impl TryFrom<String> for PluginId {
    type Error = PluginIdError;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        if value.is_empty() || value.contains('/') {
            return Err(PluginIdError::Invalid);
        }
        Ok(Self(value))
    }
}
```

### Enums for closed choices

```rust
pub enum Permission {
    ProvidersRegister,
    ShellExec,
    FileRead,
    FileWrite,
}
```

Prefer enums over string constants when the set is known.

### Checked numeric conversions

```rust
let len = usize::try_from(frame_len).map_err(|_| Error::FrameTooLarge)?;
let end = start.checked_add(len).ok_or(Error::RangeOverflow)?;
```

Avoid production `as usize` / `as u64` unless the invariant is obvious, local, and documented. If saturation or wrapping is intended, use `saturating_*` or `wrapping_*` so the semantics are visible.

### Visible dangerous boundaries

Make unavoidable dynamic or privileged operations easy to spot in review:

```rust
struct RawRpcFrame(serde_json::Value);
struct TrustedPluginPath(PathBuf);
struct ShellCommand { program: OsString, args: Vec<OsString> }
```

Do not let raw protocol values, user paths, or plugin-controlled commands flow directly into execution.

## Abstraction Test

Before accepting a new abstraction:

- What concrete bug or duplication does it address?
- Did it come from working code or a real invariant?
- Does it preserve performance and readability?
- Is the simple version worse in a specific way?
- Can a maintainer understand the call site without understanding all internals?

If not, prefer straightforward code and revisit after the second or third real use case.

## Red Flags

- `String` used for several different IDs in one API
- `serde_json::Value` passed deep into core logic
- Manual validation repeated in multiple call sites
- Boolean parameters whose meaning is unclear (`true, false, true`)
- Unchecked `as` casts on lengths, indexes, timestamps, or protocol values
- Comments saying "must be valid" but no type or constructor enforcing it
- Generic abstractions introduced before concrete duplication exists
- Safe usage requires callers to remember a separate validation step

## Verification

Before considering the design ready:

- [ ] Raw external input is converted at a clear boundary
- [ ] Core logic accepts validated/domain types, not raw data
- [ ] Important invariants are enforced by constructors or enum variants
- [ ] Numeric conversions are checked or explicitly justified
- [ ] Dangerous operations are isolated behind visibly named types/functions
- [ ] The safe path is the easiest path at the call site
- [ ] The abstraction earns its complexity
