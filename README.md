# SAF CLI Tester

Diagnose EcoHub SAF REST connectivity with a TechUser profile bound to IAT or PROD. Supports OAuth2 client credentials, PKCS#12 mTLS, single requests, sequential polling, JSONL diagnostics and latency statistics. Native Kafka and automatic TechUser enrolment are not implemented.

`docs/architecture.md` is the authoritative specification. This release implements its first milestone.

## Installation and development

Requires Node.js >=20.15.1 and npm. No native build dependencies are required.

```sh
npm ci
npm run check
npm test
npm run build
npm run dev -- --help
```

Development compiles TypeScript before running. There is no lint configuration; strict TypeScript checks are provided. To expose the executable locally, build first and run `npm link`, then use `saf-cli-tester --help`. Direct execution also works with `node dist/cli/index.js`.

## Local configuration and profiles

Real configuration belongs outside this repository, under `~/.config/saf-cli-tester/`. Use `--config-dir <directory>` to select another local root. No files are created there until a request run creates its log.

```sh
npm run dev -- config paths
npm run dev -- config show
mkdir -p ~/.config/saf-cli-tester/profiles
cp examples/profile.oauth2.example.yaml ~/.config/saf-cli-tester/profiles/example-iat.yaml
```

Edit the copied profile with your endpoints and variable names. OAuth2 profiles reference exported environment variables for the client ID and secret; use your shell or secret manager to supply them. `.env` files are not automatically read. Never put real values in the examples or command arguments. See [profile configuration](docs/profiles.md) for OAuth2 and mTLS details.

```sh
npm run dev -- profiles list
npm run dev -- profiles show example-iat
npm run dev -- profiles validate example-iat
```

For mTLS, copy `examples/profile.mtls.example.yaml` to your external profiles directory as `example-prod.yaml`, place the real P12 file in the external certificates directory, and export the configured password variable. Validation checks readability and whether Node can use the certificate/password combination without connecting to SAF.

## Requests

```sh
npm run dev -- rest request --profile example-iat --method GET --path /example
npm run dev -- rest request --profile example-iat --method POST --path /example --body '{"foo":"bar"}' --header 'Content-Type: application/json'
npm run dev -- rest request --profile example-iat --method POST --path /example --body-file ~/saf-test-data/request.json
npm run dev -- rest request --profile example-iat --path /example --header 'Accept: application/json' --header 'X-Something: value'
npm run dev -- rest poll --profile example-iat --path /example --interval 60 --count 120
npm run dev -- rest poll --profile example-iat --path /example --interval 60 --duration 2h --timeout 30000
npm run dev -- run --profile example-iat --request examples/request.example.yaml
```

The method defaults to GET. Paths must be origin-relative and remain on the configured profile origin. Redirects are not followed. HTTPS and certificate verification are required for profiles. `--timeout` is in milliseconds and covers each HTTP exchange, including discovery/token exchanges individually. `--interval` is in seconds. Polling requires a count or duration; mutating polling requires an explicit interval. There are no overlapping requests or catch-up bursts. Ctrl+C/SIGTERM aborts active work and prints statistics.

PROD is displayed for each run. POST, PUT, PATCH and DELETE require `--allow-prod-write` in PROD, checked before authentication, body-file reads or network access. CLI arguments cannot change a profile's environment.

## Diagnostics and security

Each run writes `~/.config/saf-cli-tester/logs/<runId>.jsonl` with timestamps, sequence, profile/environment, method/path, status, latency, request/correlation IDs and classified failures. The final summary includes success/4xx/5xx/500/timeout counts, rates and min/average/p50/p95/max latency. Percentiles use the nearest-rank definition. Failed requests produce exit code 1; interruption produces 130.

Logs omit request/response bodies, URL query values and arbitrary headers to avoid recording customer payloads. They retain selected correlation headers. Response bodies are consumed with a 1 MiB limit. These diagnostics therefore do not capture arbitrary server error text. Treat profile names, path segments and correlation IDs as potentially sensitive and protect the local logs. New log files use mode 0600 and new directories 0700.

All console/log output uses central recursive redaction. Tokens are cached only in memory. Real secrets, certificates, customer payloads and local profiles must remain outside Git. Review [security guidance](docs/security.md), [configuration](docs/configuration.md) and the ignore rules before using real SAF data. Before any future commit/push, inspect `git status` and `git diff --cached`.

Kafka produce/consume, interactive profile creation, scenarios and comparisons are planned later; the separate auth, config, logging and statistics modules leave room for them.
