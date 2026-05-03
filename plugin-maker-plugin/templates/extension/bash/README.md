# Bash extension template

Pure bash + jq implementation of Synaps' JSON-RPC extension protocol. Uses
`Content-Length` framing on stdio and dispatches hooks through `hook.handle`.
