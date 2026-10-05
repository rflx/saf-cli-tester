# Security

Keep real credentials, profiles, certificates, customer payloads and diagnostic logs outside this Git repository. Recommended root: `~/.config/saf-cli-tester/`. Apply restrictive filesystem permissions to all manually created secret files and directories. Existing directory permissions are not changed by the CLI.

`.gitignore` excludes environment files (except the safe `.env.example`), local `profiles/`, secrets, certificates, P12/PFX/private-key/PEM files, logs and generated output. Ignore rules do not protect already tracked files or arbitrary payload filenames. Review `git status` and `git diff --cached` before committing or pushing. Do not stage arbitrary local configuration directories.

All application console and JSONL output uses central sanitization: sensitive field names are normalized for case, hyphens and underscores; nested objects/arrays are sanitized; registered credentials/tokens are scrubbed from strings; binary buffers and PEM material are redacted. This cannot recognize every form of customer data. Request/response payloads, query values and arbitrary response headers are therefore omitted. Path segments, profile names and request/correlation IDs can still be sensitive; protect logs accordingly. Node/npm tooling output is outside the application's logging layer.

Never pass secrets in CLI flags: shell history and process listings can reveal them. Use environment variables or a local secret manager. `.env` files are not auto-loaded. Use body files outside the repository for sensitive payloads. No token is written to disk.

Profiles require HTTPS with certificate validation. REST paths cannot escape the profile origin. Redirects are not followed, including authentication redirects. OAuth discovery is a trusted configuration source and can select another HTTPS token origin. Authentication response contents and certificate parser errors are suppressed. New logs use exclusive creation and private file modes.

PROD is prominently included in run output and request records. Mutating methods require `--allow-prod-write`; the guard executes before authentication/network access. Mutating polls also require an explicit interval. This first milestone keeps PROD protection enabled; configurable safety policy is deferred. Tests use dummy secrets and mocks/local servers, never SAF credentials. Real SAF tests must be explicitly initiated manually.
