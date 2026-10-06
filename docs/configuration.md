# Configuration

The default root is `~/.config/saf-cli-tester/`, expanded using the current user's home directory. `--config-dir` overrides it. `config paths` reports `config.yaml`, `profiles/`, `secrets/`, `certificates/`, `requests/` and `logs/`. `config show` reports sanitized application defaults. Reading config does not create directories.

An optional `config.yaml` supports:

```yaml
rest:
  timeoutMs: 30000
  diagnosticBodyMaxBytes: 65536
  headers:
    Accept: application/json
poll:
  intervalSeconds: 60
```

Unknown fields are rejected. Priority is CLI arguments, template, profile, application configuration/defaults. Headers merge case-insensitively at each level. CLI body/body-file replaces a template's body source. CLI count or duration replaces the corresponding template polling bound. Both together are rejected. Environment is always taken from the profile.

Request templates use `request.method`, `path`, `headers`, `body` or `bodyFile`, and `timeoutMs`. `poll` supports `intervalSeconds`, `count` or `duration`. Duration units are `ms`, `s`, `m`, `h`; fractional positive values are supported. `expect.status` specifies accepted success statuses; HTTP non-2xx remains a failure. Relative template body paths resolve beside the template; CLI body paths resolve from the working directory. `~` expansion is supported.

`body` accepts strings and structured JSON values, including nested objects and arrays. Body strings and permitted header values support `{{uuid}}` (per-request UUID v4), `{{nowUtc}}` (current RFC3339 UTC timestamp) and `{{env:VARIABLE_NAME}}` (nonempty process environment value). Resolution happens separately for each request and poll iteration; values are never generated when loading a template. Missing/empty environment variables report their name in a `CONFIG_ERROR`; unknown/malformed placeholders also fail before the target HTTP request. No code or shell evaluation is supported. Paths, body-file filenames and object/header names cannot contain placeholders. Environment values are centrally redacted and request bodies remain excluded from request logs and exports. See [request template details and the General API example](requests.md).

Missing application config uses defaults; malformed/unreadable existing config fails. Profiles are named `<name>.yaml`, with names restricted to letters, numbers, `_` and `-`, starting with a letter/number. The file name must match the profile's name. Credentials are reusable profile fields under `credentials.oauth2` and `credentials.mtls`; secrets may be direct local values or process-environment references, with no mixing within a credential definition. `.env` files are not automatically loaded. REST authentication comes from `rest.auth`; Kafka authentication comes from `kafka.auth` (mTLS only). REST and Kafka are independently optional, with at least one required. Deprecated top-level `auth` is normalized for legacy REST profiles; combining it with new credentials or REST auth is rejected. See [profile configuration and migration](profiles.md). Never store real payloads in tracked files.

`rest.diagnosticBodyMaxBytes` controls HTTP 4xx/5xx body capture in bytes (default 65536, integer 0–1048576). It is an application setting, not a request/template override. See [REST diagnostics](diagnostics.md).
# Native Kafka configuration

Kafka uses existing Profile/Auth v2 brokers and mTLS credentials. Consume requires `--topic`, an explicit SAF `--group-id` and `--count` or `--duration`. `--client-id` accepts a UUID, otherwise one is generated. `--from-beginning` defaults false; `--include-payload` defaults false; `--max-payload-bytes` defaults 65536. Optional `--export`/`--output` follow existing export rules. See [Kafka](kafka.md) for complete behavior.

## Shared request credentials and profile placeholders

Optional `credentials.shared` stores secret `licenceKey` and `password` values, or the complete `licenceKeyEnv`/`passwordEnv` pair. Partial, empty or mixed pairs are invalid. They are separate from REST OAuth2/mTLS and Kafka mTLS authentication and are never sent automatically. Only explicit `{{profile:credentials.shared.licenceKey}}` and `{{profile:credentials.shared.password}}` references can access profile data. Missing values fail before network access with `CONFIG_ERROR`. Both secrets and encoded forms are centrally redacted, including echoed diagnostics; request payloads are not logged. See [templates](templates.md) for execution timing, polling and generic General API examples.
