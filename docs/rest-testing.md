# REST console responses

`rest request`, `rest poll` and `run` use compact metadata and summaries by default. Successful response bodies are not printed or logged.

Add `--show-response` to print the HTTP response body after each request's normal metadata. Valid JSON (including arrays and nested objects) uses two-space indentation; non-JSON is plain text; an empty body displays `Response: <empty>`. A timestamp and request number separate iterations. Polling remains sequential, with no overlap.

```sh
npm run dev -- rest poll --profile <profile-name> --path /some/path --interval 60 --count 5 --show-response
npm run dev -- run --profile <profile-name> --request templates/general-api/saf-receivers.yaml --show-response
```

Bodies are displayed for 2xx, 3xx, 4xx and 5xx HTTP responses. Redirects are not followed. Existing status classification, expected-status checks and exit codes remain unchanged; an empty body is not an error. Network/authentication failures without an HTTP resource response have no body to show.

Console capture is capped at 1 MiB. A failed read or oversized error response displays an explicit unavailable marker rather than partial content, avoiding partial-secret leaks. The existing successful-response size failure policy remains unchanged. Error console capture is independent of `rest.diagnosticBodyMaxBytes`, even when diagnostic capture is disabled.

All JSON/text output passes through central redaction and the logger before console writing. Recognized credential fields, registered OAuth client secrets/tokens, shared password/licenceKey, P12 passwords and Authorization values are redacted, including echoed credentials. Request bodies are never printed by this flag.

This is console-only presentation: JSONL, bounded 4xx/5xx diagnostics, request-body logging policy, CSV and summary exports are unchanged. Successful bodies are never added to persistent diagnostics by this flag. Protect displayed business data, which may remain sensitive after credential redaction.

## HTTP protocol selection

All three REST entry points accept `--http-version auto`, `--http-version 1.1`, and `--http-version 2`. Only these exact values are valid. The default is `auto`, which preserves the existing Node HTTP/1.1 transport. No profile/global default or template schema change is introduced; protocol selection is a CLI runtime option.

`1.1` uses `node:http` or `node:https`. The reported version comes from the response and can include `1.0` if a server responds with that version. `2` uses `node:http2` and currently requires HTTPS; cleartext HTTP/2 (h2c) is unsupported.

HTTP/2 uses TLS ALPN and checks that the negotiated protocol is `h2` before sending the API request. A server that cannot negotiate it fails with `HTTP_PROTOCOL_ERROR` and a message explaining the negotiation failure. No HTTP/1.1 fallback occurs. TLS certificate failures remain `TLS_ERROR`; stream/session protocol errors become `HTTP_PROTOCOL_ERROR`, resets use the existing reset classification, and timeout/abort retain the existing `TIMEOUT` classification.

OAuth2 and mTLS are independent of protocol choice: OAuth2 + HTTP/1.1, OAuth2 + HTTP/2, mTLS + HTTP/1.1 and mTLS + HTTP/2 are supported. OAuth discovery and token acquisition keep their existing transport and caching. The option applies to the target API. HTTP/2 accepts the same P12/PFX bytes and passphrase as HTTP/1.1, without PEM conversion. Existing certificate validation, CA handling and SNI are retained.

Bodies, runtime placeholders, status diagnostics and `--show-response` share the same high-level logic. JSON is pretty-printed, text remains text, empty responses show the empty marker, and central secret redaction applies under both protocols. HTTP/2 excludes connection-specific headers, retains normal headers and valid Content-Length, and uses stream framing rather than chunked transfer encoding.

Each iteration displays `HTTP version: <actual version>` and JSONL REST records include `transport: rest` and `httpVersion` when an HTTP response is received. Failed negotiations have no actual response version. CSV and summary schemas remain unchanged to preserve existing consumers; use JSONL for protocol comparisons.

Polling stays sequential and creates a separate HTTP/2 session per request. Sessions and streams are destroyed on completion, timeout, cancellation or failure. Ctrl+C also cancels the current request. This milestone adds no pooling.

## Manual smoke tests

Use a configured local profile and replace the path placeholders for your environment. Compare response status/body and the actual reported version:

```sh
npm run dev -- rest request \
  --profile <profile-name> --method GET \
  --path /saf/v1/<ecohub-id>/commission/out \
  --http-version 1.1 --show-response

npm run dev -- rest request \
  --profile <profile-name> --method GET \
  --path /saf/v1/<ecohub-id>/commission/out \
  --http-version 2 --show-response

npm run dev -- rest poll \
  --profile <profile-name> \
  --path /saf/v1/<ecohub-id>/commission/out \
  --interval 60 --duration 30m --http-version 1.1

npm run dev -- rest poll \
  --profile <profile-name> \
  --path /saf/v1/<ecohub-id>/commission/out \
  --interval 60 --duration 30m --http-version 2

npm run dev -- run \
  --profile <profile-name> \
  --request templates/general-api/saf-receivers.yaml \
  --http-version 2 --show-response
```

Repeat with OAuth2 and mTLS profiles as available. Existing templates, including `saf-insurers.yaml`, need no changes.

## Protocol troubleshooting

- `HTTP/2 requested but server did not negotiate h2`: check that the API endpoint and any TLS proxy/load balancer support HTTP/2. Use explicit `1.1` for comparison; the tool does not retry automatically.
- `HTTP/2 mode currently requires HTTPS`: select an HTTPS origin or HTTP/1.1.
- `TLS_ERROR`: check the trust chain, hostname/SNI, certificate validity and client P12 credentials. Certificate validation is not bypassed by selecting HTTP/2.
- `HTTP_PROTOCOL_ERROR`: inspect the JSONL network error code for a stream/session failure or invalid response. An incomplete response fails or retains existing bounded error-response read-failure diagnostics.
- `TIMEOUT`: compare both protocols with the same `--timeout` and verify endpoint reachability. Ctrl+C intentionally uses the existing abort classification.

Automated tests use local Node HTTP/HTTPS/HTTP2 servers and temporary self-signed certificates generated with OpenSSL. They require no EcoHub access or real credentials.
