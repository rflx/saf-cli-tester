# Profiles

A profile represents one TechUser in exactly one environment, `IAT` or `PROD`. There is no environment override. Make separate profiles for separate environments. Keep profiles under the external configuration root's `profiles/` directory and use `.yaml` filenames matching `name`.

See the safe [OAuth2 example](../examples/profile.oauth2.example.yaml) and [mTLS example](../examples/profile.mtls.example.yaml). All configured URLs require HTTPS without user information or fragments. Profile `rest` supports `baseUrl`, optional `timeoutMs` and `headers`.

OAuth2 requires one complete credential pair (described below), and `tokenEndpoint` or `openIdConfigurationUrl`. An explicit endpoint takes precedence over discovery. Optional nonempty `scope` is passed to the token request; EcoHub SAF requires `https://graph.microsoft.com/.default`. `tokenAuthMethod` defaults to `client_secret_basic`; `client_secret_post` sends the credentials in the form body. Tokens must be Bearer tokens with a positive numeric `expires_in`. They remain in memory and refresh before expiry. Endpoints are trusted configuration: discovery may return a token endpoint on another HTTPS origin. Verify your configuration before supplying real secrets.

mTLS requires `p12Path` and `p12PasswordEnv`. Paths support `~/`. Relative certificate paths resolve from the working directory; prefer absolute or home-relative paths. Certificate material is loaded only during explicit validation or a request, and is never logged. Server certificate verification remains enabled.

`profiles list` prints names, environments and auth modes. `profiles show <name>` prints sanitized configuration. `profiles validate <name>` checks structure, URLs, referenced variable presence and, for mTLS, readable/useable P12 material. Validation does not perform authentication or any network request. Invalid profiles fail clearly without echoing YAML contents or secret values.

OAuth2 profiles accept either direct `clientId` + `clientSecret` or environment references `clientIdEnv` + `clientSecretEnv`. Both values in the selected pair are required and nonempty; mixed direct/environment fields are rejected with no precedence rule. `profiles validate` supports both variants (environment references must be exported). `profiles show` displays `clientSecret` as `[REDACTED]`; central redaction also scrubs registered direct secrets from console output, errors and JSONL diagnostics.

Use direct secrets only in local profile files outside the Git repository, for example `~/.config/saf-cli-tester/profiles/example-iat.yaml`. Restrict permissions with `chmod 600 ~/.config/saf-cli-tester/profiles/example-iat.yaml`. Never put real credentials in tracked examples or CLI arguments. Environment variables or a secret manager remain supported; `.env` files are not automatically loaded.

Example local profile (replace placeholders only in your external file):

```yaml
name: example-iat
environment: IAT
rest:
  baseUrl: https://example.invalid
auth:
  mode: oauth2
  openIdConfigurationUrl: https://example.invalid/.well-known/openid-configuration
  clientId: "LOCAL_CLIENT_ID"
  clientSecret: "LOCAL_CLIENT_SECRET"
  scope: https://graph.microsoft.com/.default
  tokenAuthMethod: client_secret_basic
```

OAuth2 `auth.scope` is optional and must be a nonempty string when configured. For EcoHub SAF, set `scope: https://graph.microsoft.com/.default`. It is included in the `application/x-www-form-urlencoded` client-credentials token request for either authentication method. Omitting it preserves existing token request behavior.

`AUTH_ERROR` diagnostics retain the OAuth2 exchange stage, HTTP status and sanitized string fields `error` and `error_description` under `oauth2` in request results and JSONL logs. Error fields are limited to 1024 characters and control characters are removed. Other response fields and non-JSON bodies are omitted; client secrets and access tokens are redacted.
