# Pria Vault Curator

A deliberately thin Synaps extension that exposes Pria's audited vault-curation workflow. It registers six stable tools and forwards their JSON inputs to the configured Pria API; all policy, review, mutation, and verification logic remains server-side.

## Tools

`audit_vault` · `inspect_vault_gap` · `propose_vault_patch` · `request_vault_patch_publish` · `get_vault_patch_status` · `verify_vault_patch`

The proposal and publish-request steps are intentionally separate: proposing content never writes directly to a vault.

## Configuration

Set plugin config `pria_base_url` to the Pria API origin, such as `https://pria.example.com`. Export `PRIA_AGENT_TOOL_TOKEN` in the extension environment. This is the **only** credential read by the plugin; raw Pria API keys are not supported and there is no fallback.

The client uses Python's standard library and has no third-party runtime dependencies.

## Test

```bash
python3 -m unittest discover -s pria-vault-curator-plugin/tests -v
```
