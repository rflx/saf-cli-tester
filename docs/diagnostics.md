# REST diagnostics

HTTP 4xx/5xx JSONL records retain the original `statusCode`, `errorType` (for example `HTTP_500`) and timing, plus `responseHeaders` and `responseBody` when available. The central redactor sanitizes captured bodies and headers before persistence. Request payloads are never recorded. Success body logging remains unchanged; the console prints no response bodies.

Response headers are selected case-insensitively and stored using lowercase names. Only present headers from this allowlist are included: `traceparent`, `tracestate`, `x-request-id`, `x-correlation-id`, `request-id`, `correlation-id`, `x-ms-request-id`, `x-ms-correlation-request-id`, `x-ms-client-request-id`, `x-azure-ref`. Arbitrary headers, cookies and authorization headers are excluded.

`responseBody.type` is `json`, `text`, `empty` or `binary`. JSON contains a sanitized structured `value`; malformed JSON falls back to sanitized text. Empty and binary responses contain no value. Nontext media types and text containing binary control bytes or invalid UTF-8 are treated as binary. Missing content types are checked as text. Encoded/compressed payloads are not decompressed for diagnostics.

Capture is bounded by `rest.diagnosticBodyMaxBytes` in local `config.yaml`, default 65536 bytes, configurable from 0 to 1048576. Remaining bytes are drained without retaining them. `truncated: true` records that the limit was exceeded; truncated content is replaced by `[OMITTED: truncated response]` to avoid leaking credentials split at the boundary. Reading failures record `responseBodyReadFailed: true`; diagnostic processing failures record `responseDiagnosticsFailed: true`. Neither replaces the original HTTP classification. Authentication endpoints retain their existing separate restricted diagnostics.

Logs remain local under the configured logs directory. HTTP error response bodies may contain sensitive business data even after secret redaction. Protect them, keep them outside the repository, and never commit them to Git.

Example sanitized record:

```json
{"statusCode":500,"durationMs":842,"requestId":"abc123","result":"failure","errorType":"HTTP_500","responseHeaders":{"x-request-id":"abc123"},"responseBody":{"type":"json","value":{"title":"Internal Server Error","status":500,"access_token":"[REDACTED]"},"truncated":false}}
```
