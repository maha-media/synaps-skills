# Extension Showcase Demo

This plugin is a proof-of-concept for the Synaps plugin/extension platform.

After install, it demonstrates four capabilities from one standalone extension:

1. **Registered extension tool**
   - Tool name: `extension-showcase:showcase_note`
   - Writes a local JSONL note under `$SYNAPS_BASE_DIR/memory/extension-showcase.jsonl`.

2. **Hook policy**
   - Watches `bash` calls containing `rm -rf`.
   - Blocks broad destructive commands like `rm -rf /`.
   - Asks for confirmation on other `rm -rf` commands.

3. **Lifecycle/content hooks**
   - Records session start/end events.
   - Records lightweight assistant-message-complete metadata, not full content.

4. **Extension-provided model provider**
   - Model ID: `extension-showcase:showcase:demo-small`
   - Returns a local, deterministic response summarizing the last user message.
