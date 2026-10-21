# Development

Installed CLI commands use `saf-cli-tester ...`. In a development checkout, use `npm run dev -- ...` to build and run current source. The global command can be invoked inside the repository, but still runs the installed release.

```sh
npm ci
npm run check
npm test
npm run build
npm run dev -- profiles examples
npm pack --dry-run
```

## Bundled resource conventions

No manifest or registry is required. Discovery is driven by filenames and directories in the installed package, resolved relative to the ESM module rather than the working directory.

| Resource | Convention | Discovered name |
| --- | --- | --- |
| Profile example | `examples/profile.<name>.example.yaml` | `<name>` |
| Request example | `examples/request.<name>.example.yaml` | `<name>` |
| Existing default request example | `examples/request.example.yaml` | `request` |
| Executable template | `templates/<category>/<name>.yaml` | `<category>/<name>` |

Names start with a letter or number and contain letters, numbers, `_` or `-`. Template directory components follow the same rule; nested categories are supported. Symlink entries are excluded. Avoid duplicate discovered request names: `request.example.yaml` and `request.request.example.yaml` would conflict.

`examples/` contains references with placeholders to adapt. `templates/` contains executable requests whose endpoints and credentials come from the selected profile. Local custom copies live under `~/.config/saf-cli-tester/requests/` outside Git. The package files allowlist includes `dist/`, `templates/`, `examples/`, `README.md` and `package.json`.

## Add a profile example

1. Add YAML using `examples/profile.<name>.example.yaml`, including a top-level scalar `name`.
2. Ensure it contains no real secrets or certificate material.
3. Add or update schema, discovery and initialization tests.
4. Run `npm pack --dry-run` and verify the file is included.
5. Verify `saf-cli-tester profiles examples` against the updated installed package, or `npm run dev -- profiles examples` in the checkout.

## Add a request example

1. Add YAML using `examples/request.<name>.example.yaml`. The existing `examples/request.example.yaml` remains the default `request` reference.
2. Add or update tests and use only placeholders for secrets.
3. Verify `saf-cli-tester requests examples` against the updated installation (or `npm run dev -- requests examples`).
4. Run `npm pack --dry-run` to verify inclusion.

## Add an executable template

1. Add YAML under `templates/<category>/` using `<name>.yaml`, without real secrets.
2. Add or update schema, placeholder, discovery and exact-copy tests.
3. Verify `saf-cli-tester requests templates` against the updated installation (or `npm run dev -- requests templates`).
4. Run `npm pack --dry-run` and verify package contents.

Initialization tests use temporary config roots and never contact services. Config initialization serializes `configSchema.parse({})`, so schema defaults remain the source of truth. Keep the package version unchanged during feature implementation; release preparation is a separate step.

## Security documentation maintenance

Security documentation exists in two layers:

- `.github/SECURITY.md` is the concise GitHub Security Policy.
- `docs/security.md` is the detailed CLI security documentation and canonical user guidance.

When modifying security-related behavior or documentation, maintainers and Codex must review both files and update both where the change affects their respective scope.
