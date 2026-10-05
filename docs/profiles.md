# Profiles

A profile represents one TechUser in exactly one environment, `IAT` or `PROD`. There is no environment override. Make separate profiles for separate environments. Keep profiles under the external configuration root's `profiles/` directory and use `.yaml` filenames matching `name`.

See the safe [OAuth2 example](../examples/profile.oauth2.example.yaml) and [mTLS example](../examples/profile.mtls.example.yaml). All configured URLs require HTTPS without user information or fragments. Profile `rest` supports `baseUrl`, optional `timeoutMs` and `headers`.

OAuth2 requires `clientIdEnv`, `clientSecretEnv`, and `tokenEndpoint` or `openIdConfigurationUrl`. An explicit endpoint takes precedence over discovery. Optional `scope` is passed to the token request. `tokenAuthMethod` defaults to `client_secret_basic`; `client_secret_post` sends the credentials in the form body. Tokens must be Bearer tokens with a positive numeric `expires_in`. They remain in memory and refresh before expiry. Endpoints are trusted configuration: discovery may return a token endpoint on another HTTPS origin. Verify your configuration before supplying real secrets.

mTLS requires `p12Path` and `p12PasswordEnv`. Paths support `~/`. Relative certificate paths resolve from the working directory; prefer absolute or home-relative paths. Certificate material is loaded only during explicit validation or a request, and is never logged. Server certificate verification remains enabled.

`profiles list` prints names, environments and auth modes. `profiles show <name>` prints sanitized configuration. `profiles validate <name>` checks structure, URLs, referenced variable presence and, for mTLS, readable/useable P12 material. Validation does not perform authentication or any network request. Invalid profiles fail clearly without echoing YAML contents or secret values.
