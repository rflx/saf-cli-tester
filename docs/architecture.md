# SAF CLI Tester

## 1. Purpose

`saf-cli-tester` is a command-line diagnostic and testing tool for EcoHub SAF.

The primary goal is to reproduce, diagnose, and document connectivity and service issues against real SAF environments.

Initial use cases include:

- Execute authenticated REST requests against SAF.
- Repeat requests at configurable intervals, especially once per minute.
- Detect and record intermittent HTTP 5xx errors.
- Compare behaviour between different TechUsers.
- Support both IAT and PROD environments.
- Support real SAF credentials locally without ever committing credentials or sensitive data to Git.
- Later support native Kafka produce/consume testing.
- Later support reusable test scenarios and comparisons between profiles.

The tool is intended primarily for technical support, integration diagnostics, and controlled testing.

---

# 2. Core Principles

## 2.1 Configuration over hardcoding

No SAF URL, TechUser, credential, certificate path, request payload, topic, or environment-specific value should be hardcoded in application logic.

Everything must be configurable.

Configuration priority:

1. CLI arguments
2. Request configuration/template
3. Profile configuration
4. Application defaults

Environment selection is an exception:

The SAF environment belongs to the TechUser profile and must not normally be overridden from the CLI.

A profile is therefore explicitly an IAT profile or a PROD profile.

---

## 2.2 Secrets must never enter Git

Real credentials are explicitly supported.

However, the following must never be committed:

- OAuth2 client secrets
- Access tokens
- Refresh tokens, if applicable
- PKCS#12 / P12 files
- Private keys
- Private certificates containing key material
- Certificate passwords
- TechUser enrolment secrets
- Real customer payloads
- Sensitive diagnostic logs
- Local profile configuration containing secrets

The repository may only contain safe example configurations.

---

## 2.3 REST first, Kafka second

Implementation should proceed in phases.

Phase 1:
- CLI foundation
- configuration system
- profiles
- OAuth2 authentication
- mTLS authentication
- REST request execution
- polling/repeated requests
- logging
- statistics

Phase 2:
- native Kafka connectivity
- produce
- consume
- Kafka diagnostics
- Kafka-specific authentication/configuration

Phase 3:
- reusable scenarios
- profile comparison
- advanced reporting
- optional SAF event encryption/signing support where required

---

# 3. Proposed CLI

The executable name is:

```text
saf-cli-tester
```

Development execution may initially use:

```text
npm run dev -- ...
```

The package should eventually expose a proper executable so that it can be linked locally with:

```text
npm link
```

and then called globally as:

```text
saf-cli-tester ...
```

---

# 4. Command Structure

Target command hierarchy:

```text
saf-cli-tester
│
├── config
│   ├── show
│   └── paths
│
├── profiles
│   ├── list
│   ├── show
│   ├── validate
│   └── create
│
├── rest
│   ├── request
│   └── poll
│
├── kafka
│   ├── produce
│   └── consume
│
└── run
```

Kafka commands do not need to be implemented in Phase 1, but the architecture must leave room for them.

---

# 5. Profiles

One profile represents exactly one EcoHub SAF TechUser in exactly one environment. Identity is immutable during a command; use separate profiles for different TechUsers or environments. There is no CLI environment override.

```text
Profile
├── identity
│   ├── name
│   └── environment
├── credentials
│   ├── oauth2
│   └── mtls
├── rest
│   ├── connection config
│   └── auth reference
└── kafka
    ├── broker config
    └── auth reference
```

`name` and `environment` remain top-level YAML fields. A profile may configure REST only, Kafka only, or both. At least one transport is required.

```text
credentials.oauth2 -> usable by REST
credentials.mtls   -> usable by REST and Kafka
REST auth: oauth2 | mtls
Kafka auth: mtls only
```

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

Auth references resolve to configured credentials of the matching type. The typed names `oauth2` and `mtls` are the supported references. REST commands inspect `rest.auth` automatically; future Kafka commands will inspect `kafka.auth`. No per-command auth flag is needed. Kafka configuration and local validation are implemented as preparation only; broker connections and Kafka commands remain future work.

---

# 6. Local Configuration Location

Real profiles and credentials should live outside the Git repository.

Preferred location:

```text
~/.config/saf-cli-tester/
```

Suggested structure:

```text
~/.config/saf-cli-tester/
├── config.yaml
│
├── profiles/
│   ├── broker-x-iat.yaml
│   ├── broker-x-prod.yaml
│   └── test-techuser.yaml
│
├── secrets/
│   ├── broker-x-iat.env
│   └── broker-x-prod.env
│
├── certificates/
│   ├── broker-x-prod.p12
│   └── other-techuser.p12
│
├── requests/
│   └── ...
│
└── logs/
    └── ...
```

The application should use standard home-directory expansion and must not assume a specific username.

---

# 7. Separation of Profile and Secrets

Credentials are reusable top-level profile data under `credentials`. OAuth2 accepts exactly one complete pair: `clientId` + `clientSecret`, or `clientIdEnv` + `clientSecretEnv`. Direct/environment mixing is rejected. Token discovery, optional scope, token authentication method and token caching remain unchanged.

mTLS accepts `p12Path` and exactly one of direct `p12Password` or `p12PasswordEnv`. Empty direct passwords are allowed. Paths expand `~/`; relative paths use the working directory. Shared certificate material is validated locally and loaded lazily for requests. No certificate material is logged.

Profiles and real secrets remain outside Git. Central recursive redaction protects nested credentials and registered environment-backed values. `profiles show` displays the normalized model, with client ID, client secret and P12 password redacted. `profiles validate` reports each configured transport and checks configured credentials without network access.

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

---

# 8. Authentication Abstraction

Authentication must be implemented behind a common abstraction.

Suggested interface:

```typescript
interface AuthProvider {
  prepareRequest(context: RequestContext): Promise<AuthResult>;
}
```

Implementations:

```text
OAuth2AuthProvider
MtlsAuthProvider
```

REST code must not contain OAuth-specific or certificate-specific business logic.

---

# 9. OAuth2

OAuth2 must support the client credentials flow required by the configured TechUser.

Responsibilities:

1. Read client ID and client secret securely.
2. Fetch the OpenID configuration when configured.
3. Determine the token endpoint.
4. Obtain an access token using client credentials.
5. Cache the token in memory.
6. Respect token expiry.
7. Refresh automatically when required.
8. Add the Bearer token to REST requests.
9. Never write the access token or client secret to logs.

The logger must redact:

```text
Authorization
access_token
client_secret
refresh_token
```

and equivalent case variations.

---

# 10. mTLS

mTLS authentication must support local certificate material.

Initial target:

```text
PKCS#12 / .p12
```

Configuration example:

```yaml
credentials:
  mtls:
    p12Path: ~/.config/saf-cli-tester/certificates/example.p12
    p12PasswordEnv: SAF_CERT_PASSWORD
rest:
  baseUrl: https://example.invalid
  auth:
    mode: mtls
    credential: mtls
```

Requirements:

- Load certificate only when required.
- Never copy certificate material into logs.
- Never output certificate password.
- Fail with a useful error if the file cannot be read.
- Fail clearly if the certificate/password combination cannot be used.

---

# 11. Ad-hoc REST Requests

Users must NOT be required to create request templates.

A simple request must be possible directly from the CLI.

Example:

```text
saf-cli-tester rest request \
  --profile broker-x-iat \
  --method GET \
  --path /some/api/resource
```

POST:

```text
saf-cli-tester rest request \
  --profile broker-x-iat \
  --method POST \
  --path /some/api/resource \
  --body '{"foo":"bar"}'
```

Body from file:

```text
saf-cli-tester rest request \
  --profile broker-x-iat \
  --method POST \
  --path /some/api/resource \
  --body-file ./request.json
```

Headers:

```text
--header "Accept: application/json"
--header "X-Something: value"
```

The CLI should allow multiple `--header` arguments.

---

# 12. Polling / Repeated Requests

Primary diagnostic use case:

```text
saf-cli-tester rest poll \
  --profile broker-x-iat \
  --method GET \
  --path /some/api/resource \
  --interval 60 \
  --count 120
```

Alternative duration:

```text
saf-cli-tester rest poll \
  --profile broker-x-iat \
  --method GET \
  --path /some/api/resource \
  --interval 60 \
  --duration 2h
```

The tool should support at least:

```text
--interval
--count
--duration
--timeout
```

The default polling interval should not silently be assumed for destructive requests.

---

# 13. Request Templates

Reusable request templates must also be supported.

Example:

```yaml
name: minute-poll-test

request:
  method: GET
  path: /some/api/resource

poll:
  intervalSeconds: 60
  count: 120

expect:
  status:
    - 200
```

Usage:

```text
saf-cli-tester run \
  --profile broker-x-iat \
  --request ./minute-poll-test.yaml
```

Templates complement CLI requests; they do not replace them.

---

# 14. Logging

Optional `--export csv|summary|both` on REST and template commands adds streamed allowlisted CSV rows and/or a JSON summary with run metadata. `--output` is a file for one format and a directory for both. Defaults use run-ID filenames in the local config logs directory and reject paths inside Git repositories. Export persistence reuses central redaction and existing statistics; JSONL remains unchanged without the flag. See [export details](diagnostics.md#optional-run-exports).

Logging is one of the most important parts of the project.

Each execution should receive a unique run ID.

Each request should record:

```text
timestamp
runId
sequenceNumber
profile
environment
method
path
statusCode
durationMs
requestId
correlationId
result
errorType
```

Where safely possible, sanitized server error information should also be recorded.

Example JSONL:

```json
{"timestamp":"2026-10-05T14:05:00Z","runId":"abc123","sequenceNumber":1,"profile":"broker-x-iat","environment":"IAT","method":"GET","path":"/api/example","statusCode":200,"durationMs":184}
{"timestamp":"2026-10-05T14:06:00Z","runId":"abc123","sequenceNumber":2,"profile":"broker-x-iat","environment":"IAT","method":"GET","path":"/api/example","statusCode":500,"durationMs":931}
```

JSONL should be the primary machine-readable log format.

Console output should remain human-friendly.

---

# 15. Sensitive Logging

Implement central redaction.

Never log:

```text
Authorization
Proxy-Authorization
Cookie
Set-Cookie
client_secret
access_token
refresh_token
password
p12Password
privateKey
certificate contents
```

Redaction should be recursive where practical.

Example:

```text
Authorization: [REDACTED]
```

Do not rely on developers remembering to redact fields individually.

All logging should go through one central sanitization layer.

---

# 16. Error Diagnostics

HTTP failures must not simply throw and disappear.

For each failed request capture, where available:

```text
HTTP status
latency
response headers
request/correlation ID
sanitized response body
network error code
DNS errors
TLS errors
connection resets
timeouts
```

It should be possible to distinguish:

```text
HTTP_500
HTTP_502
HTTP_503
TIMEOUT
TLS_ERROR
DNS_ERROR
CONNECTION_RESET
AUTH_ERROR
CONFIG_ERROR
```

This distinction is important for SAF support diagnostics.

---

# 17. Statistics

At the end of a polling run show a summary.

Example:

```text
Run completed

Profile: broker-x-iat
Environment: IAT

Requests:            120
Successful:          116
4xx:                   1
5xx:                   3
HTTP 500:              3
Timeouts:              0

Success rate:       96.67 %
5xx rate:            2.50 %

Latency:
min:                  91 ms
avg:                 183 ms
p50:                 132 ms
p95:                 741 ms
max:                 932 ms
```

Statistics logic should be independent from the REST implementation so it can later also be used for Kafka diagnostics.

---

# 18. PROD Safety

PROD usage is explicitly required.

The application must clearly display the active environment.

For example:

```text
Profile: broker-x-prod
Environment: PROD
```

Read-only requests should work normally.

For mutating requests:

```text
POST
PUT
PATCH
DELETE
```

against PROD, provide a safety mechanism.

Preferred behaviour:

```text
--allow-prod-write
```

A PROD write request without that flag should fail before making the request.

This safety mechanism must be configurable later, but enabled by default.

---

# 19. Profile Management

Initial commands:

```text
saf-cli-tester profiles list
```

Example:

```text
NAME                  ENV    REST    KAFKA
broker-x-iat          IAT    oauth2  mtls
broker-x-prod         PROD   mtls    mtls
support-test          IAT    oauth2  not configured
```

Show profile without secrets:

```text
saf-cli-tester profiles show broker-x-iat
```

Validate:

```text
saf-cli-tester profiles validate broker-x-iat
```

Validation should check:

- required configuration
- referenced environment variables
- certificate file existence
- URL validity
- authentication configuration

It must not expose secret values.

---

# 20. Future Profile Creation

Eventually support an interactive command:

```text
saf-cli-tester profiles create
```

Possible flow:

```text
Profile name: broker-x-iat
Environment: IAT
Authentication: OAuth2
Base URL: ...
OpenID configuration URL: ...
Client ID variable: ...
Client secret variable: ...
```

Do not implement TechUser enrolment automatically in the first version.

Keep TechUser enrolment separate from profile configuration until the SAF enrolment workflow has been implemented and tested deliberately.

---

# 21. Future Kafka Architecture

Do not implement Kafka immediately, but prepare for:

```text
saf-cli-tester kafka consume
saf-cli-tester kafka produce
```

Kafka must reuse:

- profiles
- configuration loading
- logging
- run IDs
- statistics
- secret handling

Suggested abstraction:

```text
Transport
├── RestTransport
└── KafkaTransport
```

Do not force REST and Kafka into identical APIs if that harms clarity.

Share infrastructure, not transport-specific behaviour.

---

# 22. Suggested Source Structure

Use approximately:

```text
src/
├── cli/
│   ├── index.ts
│   └── commands/
│       ├── profiles.ts
│       ├── rest-request.ts
│       ├── rest-poll.ts
│       └── run.ts
│
├── config/
│   ├── loader.ts
│   ├── schema.ts
│   ├── paths.ts
│   └── types.ts
│
├── profiles/
│   ├── loader.ts
│   ├── validator.ts
│   └── types.ts
│
├── auth/
│   ├── types.ts
│   ├── oauth2.ts
│   └── mtls.ts
│
├── rest/
│   ├── client.ts
│   ├── request.ts
│   └── poller.ts
│
├── logging/
│   ├── logger.ts
│   ├── redactor.ts
│   └── jsonl.ts
│
├── diagnostics/
│   ├── errors.ts
│   └── correlation.ts
│
├── stats/
│   ├── collector.ts
│   └── summary.ts
│
├── requests/
│   ├── loader.ts
│   └── schema.ts
│
└── index.ts
```

Tests:

```text
tests/
├── config/
├── profiles/
├── auth/
├── rest/
├── logging/
└── stats/
```

---

# 23. Repository Structure

Git repository:

```text
saf-cli-tester/
├── src/
├── tests/
├── examples/
│   ├── profile.oauth2.example.yaml
│   ├── profile.mtls.example.yaml
│   └── request.example.yaml
├── docs/
│   ├── architecture.md
│   ├── configuration.md
│   ├── profiles.md
│   └── security.md
├── .env.example
├── .gitignore
├── package.json
├── tsconfig.json
└── README.md
```

Do NOT create real profile files inside the repository.

---

# 24. .gitignore Requirements

At minimum:

```gitignore
node_modules/
dist/
coverage/

.env
.env.*
!.env.example

logs/
secrets/
certificates/

*.p12
*.pfx
*.key

.DS_Store
```

Consider also protecting:

```text
*.pem
```

but be aware that repositories may eventually contain public certificate examples.

Default should favour security.

---

# 25. Documentation

Create documentation from the beginning.

README should cover:

1. What the tool does
2. Installation
3. Local development
4. Configuration location
5. Creating profiles
6. OAuth2 example
7. mTLS example
8. Ad-hoc REST request
9. REST polling
10. Request template
11. Logs
12. Security considerations
13. PROD safety
14. Planned Kafka support

Also create:

```text
docs/architecture.md
docs/configuration.md
docs/profiles.md
docs/security.md
```

---

# 26. Technology

Use:

- Node.js
- TypeScript
- modern maintained dependencies
- strict TypeScript configuration

Prefer small dependencies.

Potential categories:

- CLI parsing
- YAML parsing
- configuration validation
- HTTP client if Node built-ins are insufficient
- structured logging

Do not add dependencies without a clear purpose.

Check compatibility with the Node.js version installed on the development machine before selecting libraries.

---

# 27. Testing

Unit tests should cover at minimum:

- profile parsing
- profile validation
- configuration priority
- environment binding
- OAuth token handling
- secret redaction
- HTTP result classification
- polling timing logic
- statistics calculations
- PROD write protection

HTTP tests must use mocks/local test servers.

Automated tests must never require real SAF credentials.

Real SAF integration testing remains an explicit manual/integration operation.

---

# 28. Git Security

Before every commit, sensitive files must remain excluded.

Add documentation recommending:

```text
git status
git diff --cached
```

before pushing.

Never automatically add arbitrary local configuration directories to Git.

Real SAF payload files should preferably live outside the repository.

---

# 29. First Implementation Milestone

For the first implementation, build only:

1. TypeScript project foundation
2. CLI framework
3. config path handling
4. profile loader
5. profile validation
6. OAuth2 configuration abstraction
7. mTLS configuration abstraction
8. central secret redaction
9. REST single request
10. REST polling
11. JSONL logging
12. statistics
13. PROD write protection
14. example profiles
15. documentation
16. unit tests

Do NOT implement Kafka yet.

Do NOT implement automatic TechUser enrolment yet.

Do NOT add real credentials.

Do NOT add real SAF customer data.

---

# 30. Expected User Experience

Single request:

```text
saf-cli-tester rest request \
  --profile support-iat \
  --method GET \
  --path /example
```

Polling:

```text
saf-cli-tester rest poll \
  --profile support-iat \
  --method GET \
  --path /example \
  --interval 60 \
  --count 120
```

Request body:

```text
saf-cli-tester rest request \
  --profile support-iat \
  --method POST \
  --path /example \
  --body-file ~/saf-test-data/request.json
```

Template:

```text
saf-cli-tester run \
  --profile support-iat \
  --request ~/saf-test-data/minute-poll.yaml
```

Profiles:

```text
saf-cli-tester profiles list
saf-cli-tester profiles show support-iat
saf-cli-tester profiles validate support-iat
```

---

# 31. Implementation Instructions for Codex

Before modifying files:

1. Inspect the current repository.
2. Inspect the installed Node.js and npm versions.
3. Review the existing `.gitignore`.
4. Propose the exact package/dependency choices.
5. Show the planned directory structure.
6. Identify security-sensitive implementation areas.
7. Then implement the first milestone.

After implementation:

1. Run TypeScript checks.
2. Run linting if configured.
3. Run all tests.
4. Show `git status`.
5. Summarize generated files.
6. Explain how to run the CLI locally.
7. Do not commit or push unless explicitly requested.

Security takes precedence over convenience.
