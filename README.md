# SAF CLI Tester

SAF CLI Tester is a local diagnostic CLI for testing EcoHub SAF REST and Native Kafka integrations with TechUser credentials. It supports authenticated requests and polling, reusable YAML templates, HTTP/1.1 and HTTP/2 testing, Kafka connectivity and consumption, and local diagnostic logs and exports.

## Features

- REST OAuth2 client credentials or P12/PFX mTLS authentication.
- Single REST requests, bounded sequential polling, and HTTP/1.1 or HTTPS HTTP/2.
- YAML request templates with runtime placeholders and expected-status checks.
- Optional REST response display with `--show-response`.
- Native Kafka mTLS connection tests, bounded consumption and consumer group diagnostics.
- Optional Kafka payload display and bounded JSON logging with `--include-payload`.
- Redacted JSONL diagnostics, CSV/JSON summary exports and transport statistics.
- Explicit PROD write protection.

[Quick Start](#quick-start) · [Configuration](#how-configuration-is-organized) · [CLI reference](#cli-command-reference) · [REST](#rest) · [Native Kafka](#native-kafka) · [Security](#security) · [Documentation](#documentation)

## Quick Start

Requires **Node.js >=20.15.1** and npm. From the repository root:

```sh
npm ci
npm run build
npm run dev -- --help

mkdir -p ~/.config/saf-cli-tester/profiles
cp examples/profile.full.example.yaml \
  ~/.config/saf-cli-tester/profiles/example-profile.yaml
chmod 600 ~/.config/saf-cli-tester/profiles/example-profile.yaml
```

Edit the copied file **outside Git**. Keep `name: example-profile` aligned with its filename, choose the TechUser's `IAT` or `PROD` environment, and replace placeholder endpoints and credentials. Configure REST, Kafka, or both; remove unused transports and credential blocks. The full example includes shared credentials and a certificate reference, so remove those if unused or supply their real local values before validation. Neither environment nor transport is required as a preferred choice.

```sh
npm run dev -- profiles validate example-profile
npm run dev -- profiles show example-profile
```

Validation is local: it checks configured credentials, environment variables and certificate usability without authenticating or contacting services. `show` prints a sanitized profile.

Choose a first network check for the transport you configured:

```sh
# REST: replace /some/path with an actual resource path.
npm run dev -- rest request --profile example-profile --method GET --path /some/path

# Native Kafka: test authenticated broker metadata access.
npm run dev -- kafka connection-test --profile example-profile
```

All angle-bracket values and generic resource paths below are placeholders; replace them before running commands. Examples use `npm run dev --`, which builds before execution. After building, `node dist/cli/index.js` accepts the same arguments; `npm link` also makes `saf-cli-tester` available.

## How configuration is organized

| Location | Purpose |
| --- | --- |
| Repository `examples/` | Configuration and request-schema references to copy or adapt; no real secrets. |
| Repository `templates/` | Versioned, ready-to-run request templates; the local profile supplies endpoints and credentials. |
| Local `~/.config/saf-cli-tester/` | Real profiles, certificates, custom requests and diagnostic files, outside Git. |

```text
~/.config/saf-cli-tester/
├── config.yaml     # Optional application settings
├── profiles/       # Real TechUser configuration
├── certificates/   # P12/PFX certificates
├── requests/       # Local custom request templates
└── logs/           # Run diagnostics and default exports
```

`config paths` also reports an optional `secrets/` path. **The CLI does not automatically load `.env` files.** Export environment-backed credentials through your shell or secret manager.

```sh
npm run dev -- config paths
npm run dev -- config show
npm run dev -- --config-dir ~/saf-local config paths
```

Missing `config.yaml` uses defaults: REST timeout 30000 ms, error-body diagnostic limit 65536 bytes and polling interval 60 seconds. Invalid existing configuration fails; unknown fields are rejected. Reading configuration does not create directories.

Request settings resolve in this order: CLI, template, profile, application settings/defaults. Headers merge case-insensitively. HTTP protocol selection is a CLI option, not a profile or template setting. See [configuration](docs/configuration.md) for the full schema and precedence rules.

## Profiles and credentials

Each profile belongs to one TechUser and one explicit environment (`IAT` or `PROD`); commands cannot override its environment. Save `<profile-name>.yaml` under local `profiles/`, with a matching YAML `name`. Names start with a letter or number and contain only letters, numbers, `_` or `-`.

| Profile block | Purpose |
| --- | --- |
| `credentials.shared` | Optional reusable request-level `licenceKey` and `password`; inserted only by explicit placeholders. |
| `credentials.oauth2` | REST OAuth2 authentication. |
| `credentials.mtls` | P12/PFX authentication reusable by REST and Native Kafka. |
| `rest` | HTTPS base URL, authentication reference, optional timeout and headers. |
| `kafka` | Brokers and mTLS authentication reference. |

A profile needs credentials and at least one transport. REST selects OAuth2 or mTLS through `rest.auth`; Native Kafka uses mTLS only through `kafka.auth`. Shared credentials are API data, separate from transport authentication, and are never sent automatically.

Use [the canonical full profile](examples/profile.full.example.yaml) as the reference. OAuth2 accepts a complete direct `clientId`/`clientSecret` pair or a complete `clientIdEnv`/`clientSecretEnv` pair. Shared credentials similarly accept direct `licenceKey`/`password` or environment references `licenceKeyEnv`/`passwordEnv`. Partial or mixed pairs are rejected. mTLS accepts exactly one of `p12Password` (which may be empty) or `p12PasswordEnv`.

Verify trusted OAuth discovery/token endpoints before supplying credentials; discovery may select another HTTPS origin. An explicit `tokenEndpoint` takes precedence over discovery. Prefer absolute or `~/` certificate paths; relative certificate paths resolve from the working directory.

`profiles validate` checks **all configured credentials**, including those unused by a selected transport. Local validation does not prove server acceptance. Legacy top-level `auth` remains accepted for REST and is normalized, but cannot be combined with the new credential/auth structure. See [profiles and migration](docs/profiles.md) for authentication fields, scope, token behavior and validation details.

## CLI command reference

| Command | Purpose |
| --- | --- |
| `config paths` | Show local filesystem paths. |
| `config show` | Show effective application configuration. |
| `profiles list` | List local profiles and transport authentication modes. |
| `profiles show <name>` | Show a sanitized profile. |
| `profiles validate <name>` | Validate configuration and credentials locally. |
| `rest request` | Execute one REST request. |
| `rest poll` | Execute bounded sequential REST polling. |
| `run` | Execute a YAML request template, including its polling configuration. |
| `kafka connection-test` | Test authenticated Native Kafka metadata connectivity. |
| `kafka consume` | Consume bounded Kafka messages. |
| `kafka group-describe` | Inspect an existing consumer group. |
| `help [command]` | Display help; command groups also expose this helper. |

The command groups are `config`, `profiles`, `rest` and `kafka`. Every command accepts `-h, --help`. Tables below list every command option; defaults described as “resolved settings” come from configuration precedence, rather than a Commander flag default. `—` means no default value.

### Global options

| Flag | Default | Description |
| --- | --- | --- |
| `--config-dir <directory>` | `~/.config/saf-cli-tester` | Local configuration root for all commands. |
| `-V, --version` | — | Print the CLI version. |
| `-h, --help` | — | Display help. |

Place global configuration options before the subcommand.

### config

`config`, `config paths` and `config show` have no command-specific options beyond `-h, --help`.

```sh
npm run dev -- config paths
npm run dev -- config show
```

### profiles

`profiles`, `profiles list`, `profiles show <name>` and `profiles validate <name>` have no command-specific options beyond `-h, --help`. `show` and `validate` require the positional profile name.

```sh
npm run dev -- profiles list
npm run dev -- profiles show <profile-name>
npm run dev -- profiles validate <profile-name>
```

### rest request

| Flag | Default / requirement | Description |
| --- | --- | --- |
| `--profile <name>` | Required | Local TechUser profile. |
| `--method <method>` | GET | GET, HEAD, OPTIONS, POST, PUT, PATCH or DELETE. |
| `--path <path>` | — | Origin-relative path starting with a single `/`; required after resolving settings. |
| `--body <body>` | — | Inline request body; mutually exclusive with `--body-file`. |
| `--body-file <file>` | — | Read a local request body file. |
| `--header <header>` | [] | Repeatable `Name: value` header. |
| `--timeout <ms>` | Resolved settings | Positive integer timeout in milliseconds; application default is 30000. |
| `--allow-prod-write` | Off | Explicitly permit mutating REST requests in PROD. |
| `--http-version <version>` | auto | API transport: `auto`, `1.1` or `2`. |
| `--show-response` | Off | Print the redacted HTTP response body to the terminal. |
| `--export <format>` | Disabled | `csv`, `summary` or `both`. |
| `--output <path>` | Local logs directory | Exact file for a single export format; directory for `both`. Requires `--export`. |
| `-h, --help` | — | Display command help. |

### rest poll

| Flag | Default / requirement | Description |
| --- | --- | --- |
| `--profile <name>` | Required | Local TechUser profile. |
| `--method <method>` | GET | GET, HEAD, OPTIONS, POST, PUT, PATCH or DELETE. |
| `--path <path>` | — | Origin-relative path starting with a single `/`; required after resolving settings. |
| `--body <body>` | — | Inline request body; mutually exclusive with `--body-file`. |
| `--body-file <file>` | — | Read a local request body file. |
| `--header <header>` | [] | Repeatable `Name: value` header. |
| `--timeout <ms>` | Resolved settings | Positive integer timeout in milliseconds; application default is 30000. |
| `--allow-prod-write` | Off | Explicitly permit mutating REST requests in PROD. |
| `--http-version <version>` | auto | API transport: `auto`, `1.1` or `2`. |
| `--show-response` | Off | Print the redacted HTTP response body to the terminal. |
| `--export <format>` | Disabled | `csv`, `summary` or `both`. |
| `--output <path>` | Local logs directory | Exact file for a single export format; directory for `both`. Requires `--export`. |
| `--interval <seconds>` | Resolved settings | Positive start interval; application default is 60. Mutating polls require an explicit interval. |
| `--count <n>` | — | Positive integer request bound. |
| `--duration <duration>` | — | Positive duration with `ms`, `s`, `m` or `h`, e.g. `30m`. |
| `-h, --help` | — | Display command help. |

### run

CLI values override supported template settings. A template with `poll` runs polling; otherwise `run` executes one request, even if polling flags are supplied.

| Flag | Default / requirement | Description |
| --- | --- | --- |
| `--profile <name>` | Required | Local TechUser profile. |
| `--method <method>` | GET | GET, HEAD, OPTIONS, POST, PUT, PATCH or DELETE. |
| `--path <path>` | — | Origin-relative path starting with a single `/`; required after resolving settings. |
| `--body <body>` | — | Inline request body; mutually exclusive with `--body-file`. |
| `--body-file <file>` | — | Read a local request body file. |
| `--header <header>` | [] | Repeatable `Name: value` header. |
| `--timeout <ms>` | Resolved settings | Positive integer timeout in milliseconds; application default is 30000. |
| `--allow-prod-write` | Off | Explicitly permit mutating REST requests in PROD. |
| `--http-version <version>` | auto | API transport: `auto`, `1.1` or `2`. |
| `--show-response` | Off | Print the redacted HTTP response body to the terminal. |
| `--export <format>` | Disabled | `csv`, `summary` or `both`. |
| `--output <path>` | Local logs directory | Exact file for a single export format; directory for `both`. Requires `--export`. |
| `--interval <seconds>` | Resolved settings | Positive start interval; application default is 60. Mutating polls require an explicit interval. |
| `--count <n>` | — | Positive integer request bound. |
| `--duration <duration>` | — | Positive duration with `ms`, `s`, `m` or `h`, e.g. `30m`. |
| `--request <file>` | Required | YAML request template path. |
| `-h, --help` | — | Display command help. |

### kafka connection-test

| Flag | Default / requirement | Description |
| --- | --- | --- |
| `--profile <name>` | Required | Local TechUser profile with Kafka mTLS configured. |
| `--client-id <uuid>` | Generated UUID | Explicit Kafka UUID client ID. |
| `--export <format>` | Disabled | `csv`, `summary` or `both`. |
| `--output <path>` | Local logs directory | Exact file for a single format; directory for `both`. Requires `--export`. |
| `-h, --help` | — | Display command help. |

### kafka consume

| Flag | Default / requirement | Description |
| --- | --- | --- |
| `--profile <name>` | Required | Local TechUser profile with Kafka mTLS configured. |
| `--client-id <uuid>` | Generated UUID | Explicit Kafka UUID client ID. |
| `--export <format>` | Disabled | `csv`, `summary` or `both`. |
| `--output <path>` | Local logs directory | Exact file for a single format; directory for `both`. Requires `--export`. |
| `--topic <topic>` | Required | Kafka topic to consume (normally a SAF OUT topic). |
| `--group-id <id>` | Required | Non-empty consumer group ID, sent unchanged. |
| `--count <n>` | — | Maximum records; positive safe integer. |
| `--duration <duration>` | — | Maximum duration with `ms`, `s`, `m` or `h`; at most 24.8 days. |
| `--from-beginning` | Off | Use earliest available offsets for a new/uncommitted group. |
| `--include-payload` | Off | Print redacted message values and log bounded JSON locally. |
| `--max-payload-bytes <n>` | 65536 | Persistent payload diagnostic limit, 1–1048576 bytes; does not limit console output. |
| `-h, --help` | — | Display command help. |

### kafka group-describe

| Flag | Default / requirement | Description |
| --- | --- | --- |
| `--profile <name>` | Required | Local TechUser profile with Kafka mTLS configured. |
| `--client-id <uuid>` | Generated UUID | Explicit Kafka UUID client ID. |
| `--export <format>` | Disabled | `csv`, `summary` or `both`. |
| `--output <path>` | Local logs directory | Exact file for a single format; directory for `both`. Requires `--export`. |
| `--group-id <id>` | Required | Non-empty ID of an existing consumer group. |
| `-h, --help` | — | Display command help. |

## REST

### Single requests

The default method is GET. Paths resolve from the profile's HTTPS origin, not beneath a base URL path, and must remain on that origin. Redirects are not followed.

```sh
# Simple GET
npm run dev -- rest request \
  --profile <profile-name> --method GET --path /some/path

# Show response
npm run dev -- rest request \
  --profile <profile-name> --method GET --path /some/path --show-response

# HTTPS HTTP/2
npm run dev -- rest request \
  --profile <profile-name> --method GET --path /some/path \
  --http-version 2 --show-response

# POST with non-sensitive example JSON
npm run dev -- rest request \
  --profile <profile-name> --method POST --path /some/path \
  --header 'Content-Type: application/json' --body '{"example":"value"}'
```

Choose `--body` or `--body-file`, never both; GET/HEAD cannot have a body. Use external body files for sensitive data. `--header` is repeatable; Authorization, Proxy-Authorization, Cookie, Host, Content-Length, Transfer-Encoding and Connection are reserved. Authentication headers are managed by the tool.

The positive integer `--timeout` applies to each HTTP exchange, including discovery/token exchanges individually. Only 2xx responses succeed. Template `expect.status` can narrow accepted 2xx statuses; listing non-2xx statuses does not make them successful.

### Polling

Choose one effective bound: `--count` or `--duration`. If both CLI flags are supplied, duration takes precedence; use only one to make intent clear. Durations accept positive values with `ms`, `s`, `m` or `h`, including fractional values.

```sh
# Count
npm run dev -- rest poll \
  --profile <profile-name> --path /some/path --interval 60 --count 10

# Duration
npm run dev -- rest poll \
  --profile <profile-name> --path /some/path --interval 60 --duration 30m

# Compare protocols with the same polling settings
npm run dev -- rest poll \
  --profile <profile-name> --path /some/path --interval 60 --count 5 --http-version 1.1
npm run dev -- rest poll \
  --profile <profile-name> --path /some/path --interval 60 --count 5 --http-version 2
```

`--interval` controls seconds between request starts. Execution is sequential with no overlap or catch-up bursts; slow requests extend the interval. GET/HEAD/OPTIONS use the configured interval when omitted. POST/PUT/PATCH/DELETE polling requires an explicit interval (from CLI or template), plus PROD authorization when applicable. Ctrl+C or SIGTERM aborts active work and prints final statistics.

### Request templates

`run` executes a YAML request template. A `poll` block enables polling; omit it for a single request. CLI settings override supported template values, an explicit CLI body source replaces the template body source, and CLI count/duration replaces the template bound.

```sh
npm run dev -- run \
  --profile <profile-name> --request templates/general-api/saf-receivers.yaml --show-response
npm run dev -- run \
  --profile <profile-name> --request templates/general-api/saf-receivers.yaml \
  --http-version 2 --show-response
```

These General API templates use POST: PROD profiles require `--allow-prod-write`. Relative template `bodyFile` paths resolve beside the template; CLI body-file paths resolve from the working directory. See [request schema and overrides](docs/requests.md) and [runtime placeholders](docs/templates.md).

### Viewing responses

Without `--show-response`, REST prints compact metadata and summary statistics. With it, the HTTP response body appears in the terminal: JSON is pretty-printed, plain text is supported, and empty/unavailable bodies are identified. Central secret redaction applies.

This flag controls **console output only**; it does not add successful bodies to JSONL or exports. Bounded 4xx/5xx diagnostics are recorded independently. Console response capture is limited to 1 MiB. See [REST output details](docs/rest-testing.md).

### HTTP/1.1 and HTTP/2

| Value | Behavior |
| --- | --- |
| `--http-version auto` | Default; preserves the existing HTTP/1.1 transport behavior. |
| `--http-version 1.1` | Selects the HTTP/1.1 transport explicitly. |
| `--http-version 2` | Forces HTTPS HTTP/2; TLS ALPN must negotiate `h2`. No silent HTTP/1.1 fallback or cleartext HTTP/2. |

The actual response HTTP version is displayed and logged as `httpVersion` when a response is received. Both OAuth2 and mTLS work with either transport; the option applies to the API request, while OAuth discovery/token acquisition retains its default transport. Protocol selection is supported by `rest request`, `rest poll` and `run`. See [REST transport details and troubleshooting](docs/rest-testing.md).

### Exports

`rest request`, `rest poll` and `run` support exports. All three Kafka commands also expose the same export options with Kafka statistics and metadata.

| Format | Default file under `<config-dir>/logs/` | Contents |
| --- | --- | --- |
| `csv` | `<runId>.csv` | Allowlisted per-request REST or per-message Kafka metadata and error records. |
| `summary` | `<runId>.summary.json` | Run metadata and aggregate transport statistics. |
| `both` | Both files | CSV and summary. |

```sh
npm run dev -- rest poll \
  --profile <profile-name> --path /some/path --interval 60 --count 10 --export both
npm run dev -- rest request \
  --profile <profile-name> --path /some/path --export csv --output ~/saf-results/request.csv
```

`--output` requires `--export`: it is an exact filename for one format or a directory for `both`. Parent directories are created; existing files are never overwritten. Default exports inside Git repositories (including symlinked locations) are rejected. Explicit output paths are user-selected; keep them outside Git.

Exports use central redaction and exclude payloads, headers, query values, response bodies and certificate material. Kafka admin operations produce summaries but no per-message success rows; group details are in console/JSONL. See [diagnostic/export schemas](docs/diagnostics.md).

## Native Kafka

Native Kafka uses the Kafka protocol over TechUser mTLS, not HTTP. HTTP version settings do not apply; OAuth2/SASL broker authentication is unsupported. The profile supplies brokers, credentials and environment. See [Native Kafka details](docs/kafka.md).

### Connection test

```sh
npm run dev -- kafka connection-test --profile <profile-name>
```

Connects an admin client, requests broker metadata and disconnects without consuming. Success does not prove topic or group ACL access. A UUID client ID is generated per run unless supplied through `--client-id`.

### Consume

```sh
npm run dev -- kafka consume \
  --profile <profile-name> --topic <topic> --group-id <group-id> --duration 1m
```

At least one bound is required: count or duration. Both may be supplied; the first reached stops consumption. A count-only run can wait indefinitely if too few records arrive. Duration starts before connection, and cleanup can extend the elapsed run time.

Existing groups resume committed offsets. New/uncommitted groups start at latest by default; `--from-beginning` selects earliest available records without resetting committed offsets. **Consumption advances group offsets**; use an authorized dedicated diagnostic group. Ctrl+C/SIGTERM stops consumption gracefully.

The CLI requires a non-empty group ID and sends it unchanged; the SAF naming convention is not enforced or warned on. Kafka producing, SAF payload crypto and business validation are not implemented.

### Consumer groups

```sh
npm run dev -- kafka group-describe \
  --profile <profile-name> --group-id <group-id>
```

Read-only inspection reports state, protocol, active member count and safe member metadata. It does not create a group, join it or change offsets. Use it to investigate protocol mismatches and rebalances before changing consumer configuration. This client advertises `RoundRobinAssigner`; there is no assignor-selection flag. An inactive `Empty` group is valid; a missing or `Dead` group reports `KAFKA_GROUP_NOT_FOUND`.

### Viewing payloads

```sh
npm run dev -- kafka consume \
  --profile <profile-name> --topic <topic> --group-id <group-id> \
  --duration 1m --include-payload
```

Payloads are hidden by default. `--include-payload` prints redacted JSON/text values and also enables bounded JSON object/array payload inclusion in local JSONL. Binary data is represented by metadata. Keys and arbitrary headers remain omitted, and CSV/summary exports remain payload-free.

`--max-payload-bytes` limits persistent diagnostics only, not terminal output. Business data may remain sensitive after redaction; protect both displayed and stored data. See [payload formatting and limits](docs/kafka.md#viewing-consumed-payloads).

## Included templates

| Tracked template | Purpose |
| --- | --- |
| [saf-receivers.yaml](templates/general-api/saf-receivers.yaml) | POST `/general/v3/saf-receivers`. |
| [saf-insurers.yaml](templates/general-api/saf-insurers.yaml) | POST `/general/v3/saf-insurers`. |

Both templates require shared profile credentials and work with REST OAuth2 or mTLS. They supply request ID/time and user agent; no `onBehalfOf` is added. Executable General API templates live in `templates/`, not `examples/`.

Supported placeholders in request bodies and permitted header values:

| Placeholder | Value |
| --- | --- |
| `{{uuid}}` | New UUID for each request. |
| `{{nowUtc}}` | Current UTC timestamp for each request. |
| `{{env:VARIABLE_NAME}}` | Nonempty exported environment variable. |
| `{{profile:credentials.shared.licenceKey}}` | Shared profile licence key. |
| `{{profile:credentials.shared.password}}` | Shared profile password. |

Repeated UUID/time references within one request share their values; each poll iteration receives fresh values. Profile access is allowlisted to those two shared fields. Unknown/malformed placeholders or missing values fail before authentication/network access. No expressions or arbitrary property traversal are supported. See [templates](docs/templates.md).

`examples/` contains [the full profile](examples/profile.full.example.yaml), [OAuth2](examples/profile.oauth2.example.yaml), [mTLS](examples/profile.mtls.example.yaml) and [request schema](examples/request.example.yaml) references.

## Local custom requests

Keep user-specific YAML requests and customer payloads outside Git, under `~/.config/saf-cli-tester/requests/`. Copy/adapt the request reference and consult [the request schema](docs/requests.md).

```sh
npm run dev -- run \
  --profile <profile-name> \
  --request ~/.config/saf-cli-tester/requests/custom-request.yaml
```

## Diagnostics and logs

Each REST/Kafka run writes `<config-dir>/logs/<runId>.jsonl` and prints its run ID and log path. REST records include status/latency, profile/environment, request/correlation IDs when available and actual `httpVersion`. HTTP 4xx/5xx records include bounded sanitized JSON/text response diagnostics; OAuth failures may include sanitized authentication-stage diagnostics.

REST summaries report request/success counts, status/timeout counts, rates and min/average/p50/p95/max latency. Kafka summaries report messages, bytes, partitions, errors, duration and throughput. Group inspection records safe state/protocol/member metadata.

Request bodies, query values and arbitrary headers are omitted. Central redaction applies, but logs can still contain sensitive business data. See [diagnostics](docs/diagnostics.md) for fields, body limits, classification and exports.

| Exit code | Meaning |
| --- | --- |
| `0` | Successful command; REST run had no failed requests. |
| `1` | Invalid arguments/configuration, operation failure or failed REST request. |
| `130` | REST run or Kafka operation interrupted by Ctrl+C/SIGTERM without another failure. |

## PROD safety

The profile fixes the environment and each run displays it. **POST / PUT / PATCH / DELETE in PROD require `--allow-prod-write`.** The guard executes before authentication, body-file reads or network access and cannot be disabled in application configuration.

For an intentional, authorized write using a profile configured with `environment: PROD`:

```sh
npm run dev -- rest request \
  --profile <prod-profile-name> --method POST --path /some/path \
  --body-file ~/saf-test-data/request.json --header 'Content-Type: application/json' \
  --allow-prod-write
```

Mutating polls also require an explicit interval. This flag does not provide Kafka permissions or prevent consumer offset changes.

## Security

- Keep real profiles, credentials, certificates, customer payloads, logs and exports **outside Git**.
- Never pass real secrets in CLI arguments: shell history and process listings expose them. Use protected profiles, exported variables or a secret manager; use external body files for sensitive payloads.
- Apply restrictive permissions to manually created files/directories (`0600`/`0700`). New log/export files use `0600` and new directories `0700`; existing directory permissions are unchanged.
- HTTPS and server certificate/hostname verification remain enabled. Verify trusted OAuth endpoints before supplying credentials; redirects are not followed. Tokens stay in memory, and certificate/private-key material is not logged or converted to files.
- Logs and terminal payload output may contain sensitive business data. **Central redaction is not a substitute for safe storage.**

Ignore rules do not protect already tracked files or arbitrary payload names. Review `git status` and `git diff --cached` before any commit/push. Read [security guidance](docs/security.md) before using real SAF data.

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| `CONFIG_ERROR` | Validate the profile, exported variables, template and command arguments; consult command `--help`. |
| `AUTH_ERROR` | Run `profiles validate`; check OAuth endpoints, credentials, scope/token method, or P12/password. Inspect sanitized OAuth stage/status diagnostics. Local validation does not prove service acceptance. |
| HTTP `401` / `403` | Check environment, TechUser credentials and resource permissions; token failures are reported separately as `AUTH_ERROR`. |
| HTTP `404` | Check base URL and actual resource path; paths resolve from the origin. |
| HTTP `500` | Inspect sanitized response diagnostics and request/correlation IDs; use bounded polling to investigate recurrence. |
| HTTP/2 negotiation failure | Verify endpoint/proxy ALPN `h2` support; compare explicit `1.1`. There is no automatic fallback. |
| `TLS_ERROR` / Kafka TLS failure | Check trust chain, hostname, certificate validity and client P12/password; verification is never bypassed. |
| Kafka connection failure | Check profile brokers, network reachability, mTLS and broker authorization; metadata success does not prove topic/group access. |
| `KAFKA_GROUP_PROTOCOL_ERROR` | Use `kafka group-describe` to inspect existing member protocols; this client supports `RoundRobinAssigner`. |
| `KAFKA_GROUP_NOT_FOUND` | Verify the existing group ID; inspection does not create a group. |
| 0 messages consumed | Check topic/group access and offsets. New groups start at latest; `--from-beginning` does not reset committed offsets. |

See [REST troubleshooting](docs/rest-testing.md#protocol-troubleshooting), [Kafka diagnostics](docs/kafka.md#consumer-group-diagnostics) and [diagnostic fields](docs/diagnostics.md).

## Documentation

| Document | Purpose |
| --- | --- |
| [Architecture](docs/architecture.md) | Architecture specification and future direction. |
| [Configuration](docs/configuration.md) | Application settings, defaults and precedence. |
| [Profiles](docs/profiles.md) | Credentials, validation and legacy migration. |
| [Requests](docs/requests.md) | YAML request schema and CLI overrides. |
| [Templates](docs/templates.md) | Runtime placeholders and General API templates. |
| [REST testing](docs/rest-testing.md) | Response display, HTTP versions and troubleshooting. |
| [Native Kafka](docs/kafka.md) | Connectivity, offsets, payloads and group diagnostics. |
| [Diagnostics](docs/diagnostics.md) | JSONL fields, error capture and exports. |
| [Security](docs/security.md) | Secret handling, safe storage and PROD protection. |

## Development

Requires Node.js >=20.15.1 and npm.

```sh
npm ci
npm run check
npm test
npm run build
```

No native build dependencies are required. `check` runs strict TypeScript checks; no lint configuration is present. Tests use dummy credentials, mocks and local servers; HTTP transport tests generate temporary certificates with OpenSSL. Real SAF tests must be initiated manually.

## Roadmap

Planned, **not implemented**:

- Kafka producing and SAF payload encryption/decryption/signature handling.
- Automatic TechUser enrolment.
- Interactive profile creation.
- Reusable scenarios, profile comparisons and advanced reporting.

See [architecture and future milestones](docs/architecture.md). Proposed future commands there are not part of the current CLI reference.
