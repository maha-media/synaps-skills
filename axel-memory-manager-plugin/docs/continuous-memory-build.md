# Interim continuous-memory build strategy

> **Temporary revision-coupling note:** The exact command below patches to the
> current tip of the named Axel worktree, as required for integrated
> continuous-memory verification. The plugin manifest itself remains pinned to
> the unpublished Axel revision.

## Status

The memory-manager `0.3.0` Cargo manifest still pins Axel commit
`562e6508f5de0cdc0bbc803b2448aeb7431a6bed`, the unpublished project-memory
baseline. The continuous-memory integration also depends on later, likewise
unpublished Axel work that currently exists only in the designated local
worktree. Cargo therefore cannot reproduce this integrated build from the
remote source alone.

This is intentional while the Axel change awaits review. **Do not push an Axel
branch, publish an Axel crate, or publish this plugin to resolve the pin without
explicit human approval.** Pushing and publishing are release actions, not
build workarounds.

## Exact local-patch release build

Use the approved local Axel worktree as a temporary Cargo source override. Run
exactly:

```bash
cd /home/jr/Projects/Maha-Media/.worktrees/synaps-skills-continuous-memory/axel-memory-manager-plugin/extensions/memory-manager
AX=/home/jr/Projects/Maha-Media/.worktrees/axel-continuous-memory
CARGO_BUILD_JOBS=8 cargo build --release --jobs 8 \
  --config "patch.\"https://github.com/maha-media/axel\".axel.path=\"$AX/crates/axel\"" \
  --config "patch.\"https://github.com/maha-media/axel\".axel-memkoshi.path=\"$AX/crates/memkoshi\"" \
  --config "patch.\"https://github.com/maha-media/axel\".velocirag.path=\"$AX/crates/velocirag\""
```

The three patch entries must stay together:

- `axel` → `$AX/crates/axel`
- `axel-memkoshi` → `$AX/crates/memkoshi`
- `velocirag` → `$AX/crates/velocirag`

They patch the exact Git source URL declared in `Cargo.toml`; they do not edit
the manifest, lock in local absolute paths, or alter the release dependency
identity. The override applies only to that Cargo invocation.

## Why this is interim

A normal build follows the Git dependencies in `Cargo.toml` and checks out the
pinned revision from `https://github.com/maha-media/axel`. The declared commit
and the later continuous-memory Axel commits have not yet been pushed to that
source, and the declared baseline alone does not contain the complete
continuous-memory API consumed by this plugin. The local patches therefore let
maintainers build and verify the plugin against the matching current Axel
worktree without making an unauthorized remote change.

Once a human explicitly approves the Axel push/publication:

1. make the approved Axel revision available at the declared source;
2. verify that the manifest pin names the approved immutable revision;
3. run a clean release build without `--config` patches; and
4. only then retire this interim procedure in a reviewed follow-up.

Until those steps are approved and complete, the local-patch command above is
the documented build path. It is not approval to push a branch or publish any
crate.
