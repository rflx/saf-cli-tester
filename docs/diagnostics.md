# REST diagnostics

## Optional run exports

`--export csv|summary|both` adds exports alongside the existing JSONL diagnostics for requests, polling and templates. No flag means no export files or additional export console output. CSV streams one row per completed request, including HTTP, authentication, timeout and network failures. Missing status codes and identifiers are empty cells. Identifier arrays are JSON strings inside CSV cells; commas, quotes and newlines use standard CSV escaping. Cells beginning with spreadsheet formula characters are prefixed with an apostrophe.

Default files are `<config-dir>/logs/<runId>.csv` and `<config-dir>/logs/<runId>.summary.json`. Defaults must resolve outside Git repositories, including through symlinks. `--output` selects an exact file for a single format or a directory for `both`; both uses the run-ID filenames. Paths support `~`, parent directories are created with mode 0700, files use exclusive creation and mode 0600. Existing directory permissions are unchanged. Keep all exports outside Git; arbitrary custom filenames may not match ignore rules.

Only the CSV columns below are exported. Request headers, payloads, query values, response bodies, OAuth diagnostics and certificate material are excluded. All exported strings use central redaction.

```csv
timestamp,runId,sequenceNumber,profile,environment,method,path,statusCode,durationMs,result,errorType,requestId,correlationId
2026-10-05T14:05:00.000Z,example-run,1,example-iat,IAT,GET,/example,200,10,success,,request-1,correlation-1
2026-10-05T14:06:00.000Z,example-run,2,example-iat,IAT,GET,/example,500,30,failure,HTTP_500,request-2,correlation-2
```

The JSON summary uses the existing statistics schema plus run metadata. Times are UTC ISO 8601, rates are percentages, latencies are milliseconds, and p50/p95 use nearest rank. Zero-request runs report zero counts, rates and latencies. Ctrl+C/SIGTERM still produces the summary after the interrupted request completes or fails; CSV retains completed rows. Unexpected filesystem/process failures may leave partial files.

```json
{
  "runId": "example-run",
  "profile": "example-iat",
  "environment": "IAT",
  "startTime": "2026-10-05T14:05:00.000Z",
  "endTime": "2026-10-05T14:06:00.030Z",
  "requests": 2,
  "successful": 1,
  "fourXX": 0,
  "fiveXX": 1,
  "http500": 1,
  "timeouts": 0,
  "successRate": 50,
  "fiveXXRate": 50,
  "latency": { "min": 10, "avg": 20, "p50": 10, "p95": 30, "max": 30 }
}
```

## JSONL diagnostics

HTTP 4xx/5xx JSONL records retain the original `statusCode`, `errorType` (for example `HTTP_500`) and timing, plus `responseHeaders` and `responseBody` when available. The central redactor sanitizes captured bodies and headers before persistence. Request payloads are never recorded. Success body logging remains unchanged; the console prints no response bodies.

Response headers are selected case-insensitively and stored using lowercase names. Only present headers from this allowlist are included: `traceparent`, `tracestate`, `x-request-id`, `x-correlation-id`, `request-id`, `correlation-id`, `x-ms-request-id`, `x-ms-correlation-request-id`, `x-ms-client-request-id`, `x-azure-ref`. Arbitrary headers, cookies and authorization headers are excluded.

`responseBody.type` is `json`, `text`, `empty` or `binary`. JSON contains a sanitized structured `value`; malformed JSON falls back to sanitized text. Empty and binary responses contain no value. Nontext media types and text containing binary control bytes or invalid UTF-8 are treated as binary. Missing content types are checked as text. Encoded/compressed payloads are not decompressed for diagnostics.

Capture is bounded by `rest.diagnosticBodyMaxBytes` in local `config.yaml`, default 65536 bytes, configurable from 0 to 1048576. Remaining bytes are drained without retaining them. `truncated: true` records that the limit was exceeded; truncated content is replaced by `[OMITTED: truncated response]` to avoid leaking credentials split at the boundary. Reading failures record `responseBodyReadFailed: true`; diagnostic processing failures record `responseDiagnosticsFailed: true`. Neither replaces the original HTTP classification. Authentication endpoints retain their existing separate restricted diagnostics.

Logs remain local under the configured logs directory. HTTP error response bodies may contain sensitive business data even after secret redaction. Protect them, keep them outside the repository, and never commit them to Git.

Example sanitized record:

```json
{"statusCode":500,"durationMs":842,"requestId":"abc123","result":"failure","errorType":"HTTP_500","responseHeaders":{"x-request-id":"abc123"},"responseBody":{"type":"json","value":{"title":"Internal Server Error","status":500,"access_token":"[REDACTED]"},"truncated":false}}
```
