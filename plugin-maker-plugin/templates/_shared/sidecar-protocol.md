# Synaps sidecar protocol v2

Sidecars speak newline-delimited JSON over stdio. The sidecar emits a `hello`
frame immediately at startup, then handles host frames like `init`, `trigger`,
and `shutdown`.
