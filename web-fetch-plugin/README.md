# Web Fetch Synaps plugin

A generic process extension with one agent tool: `fetch_web_page(url)`. It returns bounded **static** HTML plus the text of linked, same-origin external stylesheets. It performs no browser rendering, JavaScript execution, page classification, palette analysis, or content interpretation.

## Safety policy

- HTTPS only; URLs with userinfo or ports other than 443 are rejected.
- Every hostname resolution is checked. Any non-global, private, loopback, link-local, multicast, reserved, or unspecified DNS answer rejects the request.
- The selected vetted address is pinned for the TCP/TLS connection, while TLS SNI and certificate verification remain bound to the original hostname. This avoids DNS rebinding between validation and connection.
- Up to three redirects are followed; each target is independently URL- and DNS-validated.
- HTML and CSS have network byte caps, a five-second socket timeout, and independently bounded returned text.
- Only `<link rel="stylesheet">` URLs with exactly the final page's scheme/host/port are retrieved. Their redirects must remain same-origin too.

## Run

No dependencies beyond Python 3 standard library:

```sh
cd web-fetch-plugin
python3 -m unittest discover -s tests -v
python3 main.py
```

The runtime reads and writes JSON-RPC 2.0 messages framed with `Content-Length`, on stdin/stdout. `initialize` advertises extension protocol 1 and `tools.register` is requested in `.synaps-plugin/plugin.json`.
