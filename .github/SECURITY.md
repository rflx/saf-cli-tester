# Security Policy

- Never commit real credentials, certificates, customer payloads, logs or diagnostic exports.
- Keep real local configuration and sensitive files outside the repository under `~/.config/saf-cli-tester/`. Protect local profiles and secret files with restrictive filesystem permissions (for example, mode 0600).
- Use protected local profiles, environment variables or a local secret manager for credentials. Never pass secrets in CLI arguments, where shell history and process listings can expose them. `.env` files are not automatically loaded.
- Logs and explicitly enabled payload output may contain sensitive business data, even after secret redaction. Protect logs, payloads and exports accordingly. Central redaction is not a substitute for safe storage or review before sharing.
- TLS certificate and hostname verification remain enabled. Profiles require HTTPS.
- PROD mutating requests require explicit `--allow-prod-write`; the guard runs before authentication or network access. Review the selected profile and environment before enabling writes.

For detailed credential, certificate, logging, payload, OAuth, TLS, PROD and Git guidance, read `docs/security.md` in the repository. It remains the canonical CLI security documentation.
