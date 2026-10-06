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
