# Request templates

Templates are reusable request descriptions, independent of TechUser identity and REST authentication mode. See [request syntax](requests.md) for schema, CLI overrides, body files and polling bounds.

| Placeholder | Value |
| --- | --- |
| `{{uuid}}` | Per-request RFC 4122 UUID v4 |
| `{{nowUtc}}` | Per-request UTC ISO-8601 timestamp with milliseconds and `Z` |
| `{{env:VARIABLE_NAME}}` | Nonempty exported environment value |
| `{{profile:credentials.shared.licenceKey}}` | Selected profile's shared licence key |
| `{{profile:credentials.shared.password}}` | Selected profile's shared password |

Only the two listed profile paths are allowed. OAuth2 credentials, mTLS passwords/paths, REST base URLs and Kafka brokers cannot be extracted through placeholders. Unknown and malformed placeholders return `CONFIG_ERROR`; unresolved placeholders are never sent. Missing shared values report `Missing profile credential: credentials.shared.<field>`. Environment variable names must match `[A-Za-z_][A-Za-z0-9_]*`; `.env` files are not loaded.

After profile/template loading and static validation, shared/environment references are checked and registered with central redaction before authentication can contact a server. UUID/time are generated immediately after authentication preparation and before HTTP execution. Every polling iteration repeats resolution. Repeated UUID/time references within one request share values; requests within the same millisecond can share a timestamp. The source template is not mutated.

Resolution visits nested body objects, arrays, string values and permitted header values. JSON text is parsed before substitution to escape quotes/newlines safely. Substituted secrets are literal and never interpreted again. Keys, paths and body-file names cannot contain placeholders. Reserved headers remain prohibited and header newline injection is rejected. JavaScript, shell expressions and arbitrary traversal are unsupported.

`credentials.shared` is optional and requires a complete direct `licenceKey`/`password` pair or a complete `licenceKeyEnv`/`passwordEnv` pair. Empty, partial or mixed pairs fail validation. These are request data, never transport authentication, and are never automatically attached to REST requests or Kafka configuration.

Use [saf-receivers](../examples/saf-receivers.yaml) or [saf-insurers](../examples/saf-insurers.yaml):

```sh
npm run dev -- run --profile <profile-name> --request examples/saf-receivers.yaml
npm run dev -- run --profile <profile-name> --request examples/saf-insurers.yaml
```

Both use top-level licenceKey/password body fields, generated requestId/requestTime and userAgent. They work with REST OAuth2 or mTLS and omit onBehalfOf. To poll, add an explicit interval and count/duration; PROD writes require `--allow-prod-write`.

Both shared fields and resolved environment values are registered as secrets, including encoded forms. Profile display, console/errors, JSONL, CSV and summary exports use central redaction, including echoed OAuth/REST server content. Request payloads remain excluded from diagnostics and exports. Keep actual profiles, credentials and payloads outside Git.

## Viewing template results

General API response bodies are often the primary result. Opt in to redacted console output:

```sh
npm run dev -- run \
  --profile <profile-name> \
  --request templates/general-api/saf-receivers.yaml \
  --show-response
```

The flag applies to single requests and every template polling iteration, without adding response bodies to logs or exports. See [REST output](rest-testing.md).
