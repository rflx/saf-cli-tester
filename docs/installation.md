# Installation, updates and releases

Use Node.js >=20.15.1 and npm.

TypeScript and Node.js types remain development dependencies. For global Git installs, `prepare` explicitly installs the checkout's locked dependencies in local mode before building, avoiding npm versions that inherit global mode during Git preparation. `npm run build` continues to use the project-local compiler; no global TypeScript installation is needed.

Development remains:

```sh
npm ci
npm run check
npm test
npm run build
npm run dev -- --help
npm run dev -- --version
```

For a global CLI, replace `vX.Y.Z` with a published tag:

```sh
npm install -g github:rflx/saf-cli-tester#vX.Y.Z
saf-cli-tester --version
saf-cli-tester --help
```

Without a tag (`github:rflx/saf-cli-tester`), npm installs the default branch, which is less reproducible. The `prepare` lifecycle builds TypeScript during Git installation; no checked-in build or native build dependencies are needed. The package deliberately ships built modules and bundled templates. From any directory, `run --request templates/general-api/saf-receivers.yaml` (or `saf-insurers.yaml`) falls back to the bundled template when that relative local file does not exist. Local files retain precedence.

`package.json` is the only application version source. The shared utility finds it relative to the installed module, independent of the working directory. CLI output, update User-Agent and `{{toolVersion}}` derive from it. The placeholder is nonsecret, constant for an installation and requires no profile. External specification/protocol versions remain independent.

```sh
saf-cli-tester update-check
saf-cli-tester update
```

Both commands query the public GitHub Releases API without a token, with a 10-second timeout. Only published stable tags in `vX.Y.Z` form are accepted; drafts and prereleases are excluded. Versions are compared numerically by SemVer major, minor and patch. An installation newer than the published release is never downgraded. Network/DNS, timeout, API/rate-limit, missing release, malformed response and invalid tag errors produce classified messages and failure exit status.

`update` runs directly without prompts and invokes `npm install -g github:rflx/saf-cli-tester#vX.Y.Z` with the exact validated release tag using argument arrays and no shell or sudo. npm output remains visible, including permission failures. On Windows use that npm command manually. Updates never write local SAF configuration, profiles, certificates, custom requests or logs. Ordinary CLI commands perform no update network checks.

`update-check` works in a checkout. When an update is available, self-update rejects source checkouts, `npm link`, and non-global installations, verifying the package location against `npm root -g`. Use your development Git workflow in those cases. Already-current installations exit successfully without installing.

## Maintainer release workflow

Start with a clean working tree, then:

```sh
npm run check
npm test
npm run build
npm version patch
# Alternatively: npm version minor / npm version major
git push
git push --tags
```

Standard `npm version` updates package.json and package-lock.json, creates a version commit and Git tag. No other application version strings require editing. Publish a GitHub Release for that tag afterward. Update commands use the latest published GitHub Release, not merely the newest remote or local tag. The CLI never publishes releases.
