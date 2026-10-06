# Profiles

A profile represents one TechUser in exactly one environment, `IAT` or `PROD`. There is no environment override. Make separate profiles for separate environments. Keep profiles under the external configuration root's `profiles/` directory and use `.yaml` filenames matching `name`.

See the safe [OAuth2 example](../examples/profile.oauth2.example.yaml) and [mTLS example](../examples/profile.mtls.example.yaml). All configured URLs require HTTPS without user information or fragments. Profile `rest` supports `baseUrl`, `auth`, optional `timeoutMs` and `headers`. Profiles may configure REST only, Kafka only, or both; at least one transport is required.

OAuth2 requires one complete credential pair (described below), and `tokenEndpoint` or `openIdConfigurationUrl`. An explicit endpoint takes precedence over discovery. Optional nonempty `scope` is passed to the token request; EcoHub SAF requires `https://graph.microsoft.com/.default`. `tokenAuthMethod` defaults to `client_secret_basic`; `client_secret_post` sends the credentials in the form body. Tokens must be Bearer tokens with a positive numeric `expires_in`. They remain in memory and refresh before expiry. Endpoints are trusted configuration: discovery may return a token endpoint on another HTTPS origin. Verify your configuration before supplying real secrets.

mTLS requires `p12Path` and exactly one of `p12Password` or `p12PasswordEnv`. A direct empty password is accepted for unencrypted P12 files; direct/environment mixing is rejected. Paths support `~/`. Relative certificate paths resolve from the working directory; prefer absolute or home-relative paths. Certificate material is loaded only during explicit validation or a request, and is never logged. Server certificate verification remains enabled.

`profiles list` prints names, environments and auth modes per transport. `profiles show <name>` prints sanitized configuration. `profiles validate <name>` checks structure, URLs, referenced variable presence and, for mTLS, readable/useable P12 material. Validation does not perform authentication or any network request. Invalid profiles fail clearly without echoing YAML contents or secret values.

OAuth2 profiles accept either direct `clientId` + `clientSecret` or environment references `clientIdEnv` + `clientSecretEnv`. Both values in the selected pair are required and nonempty; mixed direct/environment fields are rejected with no precedence rule. `profiles validate` supports both variants (environment references must be exported). `profiles show` displays `clientSecret` as `[REDACTED]`; central redaction also scrubs registered direct secrets from console output, errors and JSONL diagnostics.

Use direct secrets only in local profile files outside the Git repository, for example `~/.config/saf-cli-tester/profiles/example-iat.yaml`. Restrict permissions with `chmod 600 ~/.config/saf-cli-tester/profiles/example-iat.yaml`. Never put real credentials in tracked examples or CLI arguments. Environment variables or a secret manager remain supported; `.env` files are not automatically loaded.

## Reusable credentials and transport selection

Credentials live under `credentials.oauth2` and `credentials.mtls`, without a `mode` field. Transport blocks select a mode and a reference: `rest.auth` accepts `oauth2` or `mtls`; `kafka.auth` accepts `mtls` only. References are the typed credential names (`oauth2`, `mtls`), must match the mode and must exist. One shared mTLS credential can serve both transports. No command auth flag is required.

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

`brokers` must contain at least one `host:port` with port 1–65535. `kafka connection-test` and `kafka consume` establish live mTLS broker connections. Profile validation checks the schema, all configured credential variables and local certificate material, and reports each configured transport's selected auth and local validation status without network access. Credential checks run independently: a Kafka certificate failure does not hide a successful REST OAuth2 check. Shared mTLS material is checked once. Any failed configured credential makes validation fail. A REST command using a Kafka-only profile fails with a configuration message.

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

OAuth2 `credentials.oauth2.scope` is optional and must be a nonempty string when configured. For EcoHub SAF, set `scope: https://graph.microsoft.com/.default`. It is included in the `application/x-www-form-urlencoded` client-credentials token request for either authentication method. Omitting it preserves existing token request behavior.

`AUTH_ERROR` diagnostics retain the OAuth2 exchange stage, HTTP status and sanitized string fields `error` and `error_description` under `oauth2` in request results and JSONL logs. Error fields are limited to 1024 characters and control characters are removed. Other response fields and non-JSON bodies are omitted; client secrets and access tokens are redacted.
# Native Kafka profile

Profile/Auth v2 already supports Kafka; no new profile fields or consumer defaults are introduced. Native Kafka requires `kafka.brokers`, `kafka.auth.mode: mtls`, `kafka.auth.credential: mtls` and configured `credentials.mtls`. OAuth2 is rejected. Environment comes exclusively from the profile. `profiles validate` remains local, including P12 readability/password checks; live connectivity uses `kafka connection-test`. See [Kafka](kafka.md).

## Shared request credentials and profile placeholders

Optional `credentials.shared` stores secret `licenceKey` and `password` values, or the complete `licenceKeyEnv`/`passwordEnv` pair. Partial, empty or mixed pairs are invalid. They are separate from REST OAuth2/mTLS and Kafka mTLS authentication and are never sent automatically. Only explicit `{{profile:credentials.shared.licenceKey}}` and `{{profile:credentials.shared.password}}` references can access profile data. Missing values fail before network access with `CONFIG_ERROR`. Both secrets and encoded forms are centrally redacted, including echoed diagnostics; request payloads are not logged. See [templates](templates.md) for execution timing, polling and generic General API examples.
