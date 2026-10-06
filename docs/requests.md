# Request templates and runtime values

Templates support static string bodies (including JSON text), structured JSON bodies with nested objects and arrays, and external UTF-8 `bodyFile` files. Structured bodies are serialized as JSON; set `Content-Type: application/json` when appropriate. Static string bodies are sent unchanged. CLI body sources override template body sources.

Supported placeholders in body strings and permitted header values:

| Placeholder | Runtime value |
| --- | --- |
| `{{uuid}}` | New RFC 4122 version 4 UUID for each HTTP request |
| `{{nowUtc}}` | Current UTC ISO-8601 / RFC3339 timestamp, such as `2026-10-06T13:45:12.345Z` |
| `{{env:VARIABLE_NAME}}` | Nonempty exported process environment value |
| `{{profile:credentials.shared.licenceKey}}` | Selected profile shared licence key |
| `{{profile:credentials.shared.password}}` | Selected profile shared password |

Resolution runs separately on every request, including `rest poll` and template polling with `run`. UUID and time are generated immediately before the HTTP request, after authentication preparation. Repeated UUID/time placeholders within one request share the same value. Fresh timestamps reflect wall-clock time; requests within the same millisecond can have identical timestamp strings.

Placeholders may occupy an entire string or appear within it, and resolve recursively in object values and array elements. JSON text bodies with placeholders are parsed before interpolation and serialized to preserve quotes and newlines in environment values. Other text bodies are interpolated literally. Environment values are inserted literally and are never evaluated again as placeholders.

Variable names must match `[A-Za-z_][A-Za-z0-9_]*`. Missing or empty variables fail with `CONFIG_ERROR` and the variable name before authentication or HTTP access. `.env` files are not loaded automatically. Unknown or malformed double-brace placeholders also fail with `CONFIG_ERROR`. Code, shell expressions, whitespace inside placeholders and default-value expressions are unsupported.

Only body and header values support placeholders. Paths, body-file filenames and object/header names do not. Reserved request headers remain prohibited, and resolved header values must pass Node's HTTP header validation; newline injection is rejected with a safe configuration error.

Adapt the [request schema reference](../examples/request.example.yaml) for local custom requests. For General API calls, use the [versioned executable templates](templates.md), which read shared credentials from the selected profile. To poll a POST template, add `--interval 60 --count 2`; PROD writes also require `--allow-prod-write`.

Every environment placeholder value is registered with central redaction, including encoded forms, regardless of its body field or header name. Logs, debug/console output, error diagnostics and CSV/summary exports use central redaction. Request bodies remain excluded from request logging and exports. Keep actual credentials and sensitive payloads outside Git; tracked examples contain variable names only.

## Shared request credentials and profile placeholders

Optional `credentials.shared` stores secret `licenceKey` and `password` values, or the complete `licenceKeyEnv`/`passwordEnv` pair. Partial, empty or mixed pairs are invalid. They are separate from REST OAuth2/mTLS and Kafka mTLS authentication and are never sent automatically. Only explicit `{{profile:credentials.shared.licenceKey}}` and `{{profile:credentials.shared.password}}` references can access profile data. Missing values fail before network access with `CONFIG_ERROR`. Both secrets and encoded forms are centrally redacted, including echoed diagnostics; request payloads are not logged. See [templates](templates.md) for execution timing, polling and generic General API examples.
