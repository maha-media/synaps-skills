---
name: type-driven-design
description: Use when designing typed APIs, protocol/config boundaries, domain models, or refactors where invariants should be encoded in types instead of comments or runtime conventions.
---

# Type-Driven Design

Represent domain ideas as types. Make invalid states hard to express, validate untrusted input once at the boundary, and keep the safe path simple at the call site.

This skill is not a license to build type machinery for its own sake. Abstract from working code and real invariants. If a type does not prevent a bug, clarify an API, or remove repeated validation, it probably is not earning its cost.

## When to Use

Use this when touching:

- Typed APIs and module boundaries in Rust, TypeScript, or any language with enforceable type boundaries
- Plugin manifests, settings, config, or protocol frames
- IDs, paths, permissions, request IDs, command names, model/provider names
- Numeric conversions, lengths, indexes, sample rates, terminal coordinates, timestamps
- Any raw JSON/`unknown`/`serde_json::Value`, raw `String`, raw number/integer, or untrusted filesystem/network input crossing into core logic

## Core Pattern

```text
External input -> Raw/unknown type -> Validated domain type -> Runtime type
```

Examples:

```rust
struct RawManifest(serde_json::Value);
struct ValidatedManifest { id: PluginId, commands: Vec<CommandSpec> }
struct LoadedPlugin { manifest: ValidatedManifest, trust: TrustDecision }
```

```ts
type RawManifest = unknown;
type ValidatedManifest = {
  id: PluginId;
  commands: readonly CommandSpec[];
};
type LoadedPlugin = {
  manifest: ValidatedManifest;
  trust: TrustDecision;
};
```

Parse and validate at the boundary. After that, internal code should accept the validated type, not the raw representation.

## Design Checklist

Before adding or changing an API, ask:

- **Concept:** What domain concept is this value? If the name is only `String`, `string`, `number`, `usize`, `Value`, or `unknown`, is that hiding meaning?
- **Invariant:** What must always be true? Can the constructor/parser/schema enforce it?
- **Boundary:** Where does untrusted input become trusted internal data?
- **Conversion:** Should this be `TryFrom`/`FromStr`, a parser function, or a schema parse instead of ad-hoc validation?
- **Closed set:** Should this string be an enum, string-literal union, or discriminated union?
- **Numeric safety:** Are casts/conversions checked with `try_from`, `checked_*`, `Number.isSafeInteger`, or explicit range checks?
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

## TypeScript Patterns

### Branded types for semantic IDs

```ts
type Brand<T, Name extends string> = T & { readonly __brand: Name };

type PluginId = Brand<string, "PluginId">;

function parsePluginId(value: unknown): PluginId {
  if (typeof value !== "string" || value.length === 0 || value.includes("/")) {
    throw new Error("invalid plugin id");
  }
  return value as PluginId;
}
```

A brand does not validate by itself. Only create branded values in parser/constructor functions that enforce the invariant.

### Schema validation from `unknown`

Use schema validation at boundaries when JSON, config, or RPC frames enter the system. Zod example:

```ts
import { z } from "zod";

const ManifestSchema = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
  permissions: z.array(z.string()).default([]),
});

type ValidatedManifest = z.infer<typeof ManifestSchema>;

function parseManifest(input: unknown): ValidatedManifest {
  return ManifestSchema.parse(input);
}
```

After `parseManifest`, pass `ValidatedManifest` through core logic instead of raw `unknown` or untyped JSON.

### String-literal unions and discriminated unions

For small closed sets:

```ts
const PERMISSIONS = ["shell.exec", "file.read", "file.write"] as const;
type Permission = (typeof PERMISSIONS)[number];
```

For events or protocol variants, prefer discriminated unions:

```ts
type RpcEvent =
  | { kind: "started"; id: RequestId }
  | { kind: "finished"; id: RequestId; code: number }
  | { kind: "failed"; id: RequestId; error: string };
```

Use exhaustive switches so new variants do not silently fall through:

```ts
function renderEvent(event: RpcEvent): string {
  switch (event.kind) {
    case "started":
      return `started ${event.id}`;
    case "finished":
      return `finished ${event.id}`;
    case "failed":
      return `failed ${event.id}`;
    default: {
      const exhaustive: never = event;
      return exhaustive;
    }
  }
}
```

### Safe numbers and ranges

TypeScript numbers are floating-point values. Validate integers and ranges explicitly before using them as ports, lengths, indexes, durations, or protocol sizes.

```ts
type Port = Brand<number, "Port">;

function parsePort(value: unknown): Port {
  if (!Number.isSafeInteger(value) || value < 1 || value > 65_535) {
    throw new Error("invalid port");
  }
  return value as Port;
}
```

### Avoid unsafe `as` assertions

`as SomeType` is not validation. Treat assertions like a cast at a trust boundary: acceptable only immediately after a check/schema parse, or inside a narrow constructor that enforces the invariant.

## Abstraction Test

Before accepting a new abstraction:

- What concrete bug or duplication does it address?
- Did it come from working code or a real invariant?
- Does it preserve performance and readability?
- Is the simple version worse in a specific way?
- Can a maintainer understand the call site without understanding all internals?

If not, prefer straightforward code and revisit after the second or third real use case.

## Red Flags

- `String`/`string` used for several different IDs in one API
- `serde_json::Value`, `unknown`, or `any` passed deep into core logic
- Manual validation repeated in multiple call sites
- Boolean parameters whose meaning is unclear (`true, false, true`)
- Unchecked numeric casts/conversions on lengths, indexes, timestamps, or protocol values
- TypeScript `number` accepted for ports, sizes, or indexes without `Number.isSafeInteger` and range checks
- TypeScript `as SomeType` used without nearby validation
- Non-exhaustive switch over a discriminated union
- Comments saying "must be valid" but no constructor, parser, schema, or type enforcing it
- Generic abstractions introduced before concrete duplication exists
- Safe usage requires callers to remember a separate validation step

## Verification

Before considering the design ready:

- [ ] Raw external input is converted at a clear boundary
- [ ] Core logic accepts validated/domain types, not raw data
- [ ] Important invariants are enforced by constructors, parsers, schemas, or enum/union variants
- [ ] Numeric conversions are checked or explicitly justified
- [ ] Dangerous operations are isolated behind visibly named types/functions
- [ ] The safe path is the easiest path at the call site
- [ ] The abstraction earns its complexity
