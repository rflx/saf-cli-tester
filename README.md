# SAF CLI Tester

Diagnose EcoHub SAF REST and Native Kafka connectivity using a local TechUser profile for IAT or PROD. Run authenticated requests, consume bounded Kafka records, and collect local diagnostics.

**Keep real credentials, certificates, customer payloads, profiles and diagnostic files outside Git.** Use `~/.config/saf-cli-tester/` for local configuration. Redaction cannot remove every kind of sensitive business data.

## Features

- OAuth2 client credentials and PKCS#12 (`.p12`) mTLS authentication.
- Single REST requests and sequential polling by count or duration.
- YAML request templates with optional expected statuses.
- JSONL diagnostics, request/correlation IDs and latency statistics.
- Optional CSV and JSON summary exports.
- Explicit protection against PROD writes.

[Architecture](docs/architecture.md) is the authoritative architecture specification. REST diagnostics and Native Kafka connection testing/consuming are implemented; Kafka producing and automatic TechUser enrolment remain roadmap items.

## Quick Start

Requires **Node.js >=20.15.1** and npm. From the repository root:

```sh
npm ci
npm run build
npm run dev -- --help
mkdir -p ~/.config/saf-cli-tester/profiles
cp examples/profile.oauth2.example.yaml ~/.config/saf-cli-tester/profiles/example-profile.yaml
chmod 600 ~/.config/saf-cli-tester/profiles/example-profile.yaml
```

Edit the copied profile outside the repository. Choose `IAT` or `PROD` for `environment` and replace placeholder URLs with approved endpoints for that environment. Supply `SAF_EXAMPLE_CLIENT_ID` and `SAF_EXAMPLE_CLIENT_SECRET` as exported environment variables through your shell or secret manager. **`.env` files are not automatically loaded.**

```sh
npm run dev -- profiles validate example-profile
npm run dev -- profiles show example-profile
npm run dev -- rest request --profile example-profile --path /example
```

Replace `/example` with an actual SAF resource path. All URLs and resource paths in this README are placeholders. Validation is local; the final command contacts the configured service. Each run prints its environment, run ID, log location, results and final statistics.

Examples use `npm run dev --`, which builds before execution. After a build, you can also use `node dist/cli/index.js`, or run `npm link` and use `saf-cli-tester`.

## Configuration

The default root is `~/.config/saf-cli-tester/`. Inspect paths and effective application settings with:

```sh
npm run dev -- config paths
npm run dev -- config show
npm run dev -- --config-dir ~/saf-local config paths
```

Profiles belong in `profiles/`, certificates in `certificates/`, and diagnostics in `logs/` beneath that root. Reading configuration does not create directories. An optional `config.yaml` supports:

```yaml
rest:
  timeoutMs: 30000
  diagnosticBodyMaxBytes: 65536
  headers:
    Accept: application/json
poll:
  intervalSeconds: 60
```

Missing application configuration uses defaults; invalid existing configuration fails. Unknown fields are rejected. Request settings take precedence in this order: CLI, template, profile, application settings/defaults. Headers merge case-insensitively. Environment always comes from the profile. See [configuration details](docs/configuration.md).

## Profiles

A profile represents one TechUser and is permanently bound to exactly one environment: `IAT` for integration acceptance testing or `PROD` for production. The environment cannot be overridden from the CLI. Create separate profiles for separate TechUsers and environments as needed. Neither environment is the default or required choice; select the one appropriate to your TechUser. PROD has the write guard described below.

Save profiles as `<profile-name>.yaml` in the local `profiles/` directory. The filename must match the YAML `name`. Names start with a letter or number and contain only letters, numbers, `_` or `-`.

Every profile requires `name`, `environment`, reusable `credentials` and at least one transport (`rest`, `kafka`, or both). A profile can hold both OAuth2 and mTLS credentials. REST supports either; native Kafka supports mTLS only. The same `credentials.mtls` can be reused by both transports. REST commands (`rest request`, `rest poll`, `run`) select credentials automatically from `rest.auth`; users normally do not specify an auth mode in commands. Kafka commands use `kafka.auth`.

Profile `rest` requires `baseUrl` and `auth`, and accepts optional `timeoutMs` and `headers`. URLs require HTTPS without embedded credentials or fragments.

Example profile with both transports:

```yaml
name: example-profile
environment: IAT # or PROD

credentials:
  oauth2:
    clientId: "..."
    clientSecret: "..."
    openIdConfigurationUrl: https://<openid-configuration-url>
    tokenAuthMethod: client_secret_basic
    scope: https://graph.microsoft.com/.default
  mtls:
    p12Path: ~/.config/saf-cli-tester/certificates/example.p12
    p12Password: "..."

rest:
  baseUrl: https://<saf-base-url>
  timeoutMs: 30000
  auth:
    mode: oauth2
    credential: oauth2

kafka:
  brokers:
    - <kafka-broker>:9092
  auth:
    mode: mtls
    credential: mtls
```

REST using OAuth2:

```yaml
rest:
  auth:
    mode: oauth2
    credential: oauth2
```

REST using mTLS:

```yaml
rest:
  auth:
    mode: mtls
    credential: mtls
```

These snippets select credentials within a complete profile; include `rest.baseUrl` when configuring REST.

```sh
npm run dev -- profiles list
npm run dev -- profiles show example-profile
npm run dev -- profiles validate example-profile
```

`list` shows names, environments and authentication modes per transport. `show` prints sanitized configuration, including `[REDACTED]` for a direct client secret. `validate` reports configured credentials and each transport independently, checking the schema and credential availability; for mTLS it also checks certificate readability and whether Node can use the certificate/password combination. **Validation performs no authentication or network request.** See [profiles](docs/profiles.md).

## OAuth2

Example external profile, `~/.config/saf-cli-tester/profiles/example-profile.yaml`:

```yaml
name: example-profile
environment: IAT # or PROD; choose the environment for this TechUser
credentials:
  oauth2:
    openIdConfigurationUrl: https://<openid-configuration-url>
    clientIdEnv: SAF_EXAMPLE_CLIENT_ID
    clientSecretEnv: SAF_EXAMPLE_CLIENT_SECRET
    scope: https://graph.microsoft.com/.default
    tokenAuthMethod: client_secret_basic
rest:
  baseUrl: https://<saf-base-url>
  timeoutMs: 30000
  auth:
    mode: oauth2
    credential: oauth2
```

Use `openIdConfigurationUrl` for discovery or `tokenEndpoint` for an explicit token URL. If both are supplied, `tokenEndpoint` wins. Verify trusted endpoints before supplying credentials: discovery can return a token endpoint on another HTTPS origin.

Credentials must be exactly one complete pair:

- `clientIdEnv` + `clientSecretEnv`: names of exported environment variables.
- `clientId` + `clientSecret`: nonempty direct values in the external local profile.

Mixed pairs are rejected. Keep direct secrets outside Git and restrict the profile to mode `0600`. Never put real secrets in command arguments or tracked examples.

`tokenAuthMethod` defaults to `client_secret_basic`; `client_secret_post` sends credentials in the form body. Optional `scope` must be nonempty when set; for EcoHub SAF, use `https://graph.microsoft.com/.default`. Tokens must be Bearer tokens with a positive numeric `expires_in`. They are cached only in memory and renewed before expiry.

## mTLS

Example external profile, `~/.config/saf-cli-tester/profiles/techuser-profile.yaml`:

```yaml
name: techuser-profile
environment: IAT # or PROD; choose the environment for this TechUser
credentials:
  mtls:
    p12Path: ~/.config/saf-cli-tester/certificates/techuser-profile.p12
    p12PasswordEnv: SAF_EXAMPLE_P12_PASSWORD
rest:
  baseUrl: https://<saf-base-url>
  auth:
    mode: mtls
    credential: mtls
```

Start with [the mTLS example](examples/profile.mtls.example.yaml). Store the real P12 outside the repository and export the password variable through your shell or secret manager. Prefer absolute or `~/` certificate paths; relative paths resolve from the working directory.

```sh
npm run dev -- profiles validate techuser-profile
```

Use exactly one of direct `p12Password` (an empty password is allowed) or `p12PasswordEnv`; mixing is rejected.

Certificate material is loaded only during validation or a request and is never logged. Server certificate verification remains enabled.

### Migration from legacy profiles

Top-level `auth` is deprecated but remains accepted for existing REST profiles. It is normalized internally and `profiles show` displays the new structure. Move all credential fields under `credentials.<mode>` and replace top-level `auth` with `rest.auth`. Combining legacy `auth` with `credentials` or `rest.auth` is rejected with a migration error.

Old:

```yaml
rest:
  baseUrl: https://example.invalid
auth:
  mode: oauth2
  clientIdEnv: SAF_CLIENT_ID
  clientSecretEnv: SAF_CLIENT_SECRET
  tokenEndpoint: https://example.invalid/token
```

New (keep `name` and `environment` unchanged):

```yaml
credentials:
  oauth2:
    clientIdEnv: SAF_CLIENT_ID
    clientSecretEnv: SAF_CLIENT_SECRET
    tokenEndpoint: https://example.invalid/token
rest:
  baseUrl: https://example.invalid
  auth:
    mode: oauth2
    credential: oauth2
```

For legacy mTLS, move `p12Path` and `p12PasswordEnv` into `credentials.mtls` and set `rest.auth` to `mode: mtls`, `credential: mtls`.

## REST Requests

The method defaults to `GET`. Supported methods are `GET`, `HEAD`, `OPTIONS`, `POST`, `PUT`, `PATCH` and `DELETE`.

```sh
npm run dev -- rest request --profile example-profile --path /example
npm run dev -- rest request --profile example-profile --method POST --path /example --body '{"foo":"bar"}' --header 'Content-Type: application/json'
npm run dev -- rest request --profile example-profile --method POST --path /example --body-file ~/saf-test-data/request.json --header 'Content-Type: application/json'
npm run dev -- rest request --profile example-profile --path /example --header 'Accept: application/json' --header 'X-Something: value' --timeout 30000
```

Paths must start with a single `/` and stay on the profile's origin. They resolve from the origin, not beneath a base URL path. Redirects are not followed. Choose `--body` or `--body-file`, never both; GET/HEAD cannot have a body. Keep sensitive payloads in external body files. If the profile belongs to PROD, these mutating requests also require `--allow-prod-write`; see [PROD Safety](#prod-safety).

`--header` is repeatable. Reserved headers (`Authorization`, `Proxy-Authorization`, `Cookie`, `Host`, `Content-Length`, `Transfer-Encoding`, `Connection`) cannot be supplied. Authentication headers are managed by the tool.

`--timeout` is a positive integer in milliseconds. It applies to each HTTP exchange, including discovery and token exchanges individually. Any non-2xx response is a failed request.

## Polling

Choose exactly one bound: a positive integer `--count` or a positive `--duration` with units `ms`, `s`, `m` or `h`. Fractional durations are supported.

```sh
npm run dev -- rest poll --profile example-profile --path /example --interval 60 --count 120
npm run dev -- rest poll --profile example-profile --path /example --interval 60 --duration 2h --timeout 30000
```

`--interval` is in seconds and controls the interval between request starts. GET/HEAD/OPTIONS use the configured default (60 seconds unless changed) when it is omitted. POST/PUT/PATCH/DELETE polling requires an explicit interval.

Requests run sequentially, with no overlap or catch-up bursts. Slow requests can extend the actual interval. Ctrl+C or SIGTERM aborts active work and prints final statistics.

## Request Templates

Templates complement ad-hoc requests. Save reusable YAML locally; keep real payloads outside Git:

```yaml
name: minute-poll-test
request:
  method: GET
  path: /example
poll:
  intervalSeconds: 60
  count: 120
expect:
  status: [200]
```

```sh
npm run dev -- run --profile example-profile --request examples/request.example.yaml
npm run dev -- run --profile example-profile --request examples/request.example.yaml --count 5 --interval 10
```

Omit `poll` for a single request. `request` accepts `method`, `path`, `headers`, `body` or `bodyFile`, and `timeoutMs`. `poll` accepts `intervalSeconds` and exactly one of `count` or `duration`. Optional `expect.status` narrows accepted 2xx statuses; other 2xx responses become `UNEXPECTED_STATUS`. Non-2xx responses remain failures even if listed.

`run` accepts the REST request and polling flags. CLI settings override templates; an explicit CLI body source replaces the template body source, and CLI count or duration replaces the template bound. Relative template `bodyFile` paths resolve beside the template; CLI body-file paths resolve from the working directory. `~/` paths are supported.

## Diagnostics

Every run writes `<config-dir>/logs/<runId>.jsonl`. Request records include timestamps, sequence number, profile/environment, method/path, status when available, duration, request/correlation IDs when available, and classified failures. The final summary reports request and success counts, 4xx/5xx/500/timeout counts, success and 5xx rates, and min/average/p50/p95/max latency. Percentiles use nearest rank.

HTTP **4xx/5xx** records also capture sanitized JSON/text response diagnostics and allowlisted response identifiers. Request bodies, query values and arbitrary headers are omitted; successful response bodies are not logged. The console does not print response bodies.

Error-body capture defaults to **64 KiB**. Set `rest.diagnosticBodyMaxBytes` in local `config.yaml` to an integer from 0 to 1048576 bytes. Truncated bodies are marked and their content omitted to avoid partial-secret leaks. Empty and binary bodies contain metadata only. Diagnostic read/processing failures preserve the original HTTP classification.

OAuth2 `AUTH_ERROR` records can include `oauth2.stage`, HTTP status and sanitized `error`/`error_description` strings. Each string is limited to 1024 characters with control characters removed; other authentication response fields and non-JSON bodies are omitted.

**Logs can contain sensitive business data despite redaction. Protect them and never commit them.** See [diagnostics](docs/diagnostics.md) for the response-header allowlist, record format and capture behavior.

## Exports

Optional exports work with `rest request`, `rest poll` and `run`. JSONL diagnostics are still written. Without `--export`, no export files are created.

```sh
npm run dev -- rest request --profile example-profile --path /example --export csv
npm run dev -- rest poll --profile example-profile --path /example --interval 60 --count 120 --export summary
npm run dev -- rest poll --profile example-profile --path /example --interval 60 --count 120 --export both
npm run dev -- rest request --profile example-profile --path /example --export csv --output ~/saf-results/request.csv
npm run dev -- run --profile example-profile --request examples/request.example.yaml --export both --output ~/saf-results
```

| Format | Default file under `<config-dir>/logs/` | Contents |
| --- | --- | --- |
| `csv` | `<runId>.csv` | One allowlisted row per completed request, including failures |
| `summary` | `<runId>.summary.json` | Run metadata and aggregate statistics |
| `both` | Both files above | CSV and summary |

`--output` requires `--export`. For one format it is an exact filename; for `both` it is a directory containing run-ID filenames. Parent directories are created and existing files are never overwritten. Default export paths inside Git repositories, including symlinked locations, are rejected; explicit output paths are user-selected.

Exports use central redaction and exclude request payloads, headers, query values, response bodies, OAuth diagnostics and certificate material. Keep them outside Git. See [export schemas and examples](docs/diagnostics.md#optional-run-exports).

## PROD Safety

The profile fixes the environment, and each run displays it. **POST, PUT, PATCH and DELETE in PROD require `--allow-prod-write`.** The guard runs before authentication, body-file reads or network access. It cannot be disabled in application configuration.

For an intentional, authorized PROD write, using a separate profile named `example-prod` configured with `environment: PROD`:

```sh
npm run dev -- rest request --profile example-prod --method POST --path /example --body-file ~/saf-test-data/request.json --header 'Content-Type: application/json' --allow-prod-write
```

Mutating polls also require an explicit interval.

## Security

- Keep credentials, profiles, certificates, customer payloads, logs and exports outside the repository. Use restrictive permissions for manually created files and directories.
- Never pass real secrets in CLI arguments: shell history and process listings can expose them. Use exported variables, a secret manager or a protected external profile.
- HTTPS and certificate verification are required; redirects are not followed. Verify OAuth discovery/token endpoints before providing secrets.
- Central recursive redaction protects recognized secret fields and registered secrets/tokens, but profile names, path segments and correlation IDs may still be sensitive.

New log/export files use mode `0600` and new directories `0700`; existing directory permissions are unchanged. Ignore rules do not protect already tracked files or arbitrary payload filenames. Before any commit or push, inspect `git status` and `git diff --cached`. Read [security guidance](docs/security.md) before using real SAF data.

## Exit Codes

| Code | Meaning |
| --- | --- |
| `0` | Command completed successfully; a request run had no failed requests |
| `1` | Invalid arguments/configuration, command failure, or at least one failed request |
| `130` | Request run interrupted by Ctrl+C or SIGTERM |

## Useful Commands

| Task | Command |
| --- | --- |
| Top-level help | `npm run dev -- --help` |
| Request flags | `npm run dev -- rest request --help` |
| Polling flags | `npm run dev -- rest poll --help` |
| Template flags | `npm run dev -- run --help` |
| Local paths | `npm run dev -- config paths` |
| Application settings | `npm run dev -- config show` |
| List profiles | `npm run dev -- profiles list` |
| Inspect a profile | `npm run dev -- profiles show example-profile` |
| Validate locally | `npm run dev -- profiles validate example-profile` |

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| `AUTH_ERROR` | Run `profiles validate` first. For OAuth2, check trusted discovery/token URLs, credentials, scope and token authentication method; inspect the JSONL `oauth2` stage/status and sanitized error fields when present. For mTLS, check P12 readability and password compatibility. Local validation does not prove server acceptance. |
| HTTP `401`/`403` | Check that the TechUser and credentials belong to the selected environment and have access to the resource. These are REST response statuses; token-endpoint failures are reported separately as `AUTH_ERROR`. |
| HTTP `404` | Check `rest.baseUrl` and the resource path. `/example` is a placeholder; request paths resolve from the origin, not beneath a base URL path. |
| HTTP `500` | Inspect sanitized response diagnostics and request/correlation IDs in JSONL. Use bounded polling to investigate recurrence and share relevant sanitized evidence through an approved support channel. |

## Documentation

- [Architecture](docs/architecture.md) — authoritative architecture specification, including future milestones.
- [Configuration](docs/configuration.md) — defaults, precedence and template settings.
- [Profiles](docs/profiles.md) — authentication fields and local validation.
- [Diagnostics](docs/diagnostics.md) — JSONL response capture and export schemas.
- [Security](docs/security.md) — secret handling, local storage and PROD protection.

## Development

```sh
npm ci
npm run check
npm test
npm run build
```

No native build dependencies are required. `check` provides strict TypeScript checks; there is no lint configuration. Tests use dummy credentials and mocks/local servers. Real SAF tests must be initiated manually.

## Roadmap

The following are planned, **not implemented**:

- Native Kafka producing and SAF cryptographic payload handling.
- Automatic TechUser enrolment.
- Interactive profile creation.
- Reusable scenarios, profile comparisons and advanced reporting.

See [the architecture specification](docs/architecture.md) for the broader direction. Its proposed commands and future requirements do not imply current CLI support.
## Native Kafka

REST supports OAuth2 or mTLS; Native Kafka supports mTLS only. Kafka automatically selects authentication and environment from the profile.

```sh
npm run dev -- kafka connection-test --profile <profile-name>
npm run dev -- kafka consume --profile <profile-name> \
  --topic eh.saf.<ecohubId>.commission.out.v1 \
  --group-id CG-123456-IDP123456 --count 10
```

Replace placeholders with your own values. EcoHub SAF 1.2.0 documents consumer group pattern `^CG-(\d{5,6})-IDP(\d{6})$`. The CLI requires a non-empty `--group-id` and intentionally warns on deviations rather than rejecting them, because real SAF group IDs may differ. The supplied ID is sent unchanged to Kafka, which decides whether it is accepted. Client IDs are UUIDs, generated per run unless supplied with `--client-id`. Consume requires `--count` or `--duration`, resumes group offsets, and starts new groups at latest by default. Payload logging is restricted to metadata by default. Kafka produce is not implemented yet. See [Native Kafka](docs/kafka.md) for offsets, local logs, exports and the EcoHub SAF Message Broker System 1.2.0 scope.
