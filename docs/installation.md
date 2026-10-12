# Installation, updates and releases

Use Node.js >=20.15.1 and npm.

For the latest stable global CLI:

```sh
npm install -g https://github.com/rflx/saf-cli-tester/releases/latest/download/saf-cli-tester.tgz
saf-cli-tester --version
saf-cli-tester --help
```

For a specific stable version use `npm install -g https://github.com/rflx/saf-cli-tester/releases/download/v0.1.0/saf-cli-tester.tgz`. `npm install -g github:rflx/saf-cli-tester` installs development/main. The `prepare` lifecycle builds TypeScript during Git installation; no checked-in build or native build dependencies are needed. The package deliberately ships built modules and bundled templates. From any directory, `saf-cli-tester run --request templates/general-api/saf-receivers.yaml` (or `saf-insurers.yaml`) falls back to the bundled template when that relative local file does not exist. Local files retain precedence.

User-facing command examples assume this globally installed CLI. See [Quick Start](../README.md#quick-start) for profile setup and first checks.

`package.json` is the only application version source. The shared utility finds it relative to the installed module, independent of the working directory. CLI output, update User-Agent and `{{toolVersion}}` derive from it. The placeholder is nonsecret, constant for an installation and requires no profile. External specification/protocol versions remain independent.

```sh
saf-cli-tester update-check
saf-cli-tester update
```

Both commands query the public GitHub Releases API without a token, with a 10-second timeout. Only published stable tags in `vX.Y.Z` form are accepted; drafts and prereleases are excluded. Versions are compared numerically by SemVer major, minor and patch. An installation newer than the published release is never downgraded. Network/DNS, timeout, API/rate-limit, missing release/asset, invalid asset URL, malformed response and invalid tag errors produce classified messages and failure exit status.

`update` runs directly without prompts and invokes `npm install -g https://github.com/rflx/saf-cli-tester/releases/download/vX.Y.Z/saf-cli-tester.tgz` with the exact validated release tag using argument arrays and no shell or sudo. npm output remains visible, including permission failures. On Windows use that npm command manually. Updates never write local SAF configuration, profiles, certificates, custom requests or logs. Ordinary CLI commands perform no update network checks.

`update-check` works in a checkout. When an update is available, self-update rejects source checkouts, `npm link`, and non-global installations, verifying the package location against `npm root -g`. Use your development Git workflow in those cases. Already-current installations exit successfully without installing.

## Development checkout

Run these commands from the repository checkout:

```sh
npm ci
npm run check
npm test
npm run build
npm run dev -- --help
npm run dev -- --version
```

`npm run dev -- ...` builds and runs the current local source. The globally installed `saf-cli-tester ...` runs the installed release even inside the project directory. `npm run dev -- update-check` can inspect release availability; self-update requires a global installation.

TypeScript and Node.js types remain development dependencies. As described in [npm's lifecycle documentation](https://docs.npmjs.com/cli/v11/using-npm/scripts/#prepare-and-prepublish), npm installs dependencies and development dependencies before preparing a Git dependency. `prepare` runs `npm run build`, which uses the project-local compiler and makes `dist/cli/index.js` executable. It does not install dependencies itself or modify npm's global installation destination.

Direct global GitHub installation depends on npm correctly preparing and installing Git dependencies. Some npm versions can inherit global mode during Git preparation, leaving build dependencies unavailable or a global package link pointing at a temporary checkout. These npm-specific failures are not worked around by the package. If affected, use the stable GitHub Release asset above, or clone main, run `npm ci` and `npm pack`, and install the resulting tarball globally. The stable release tarball installation has been verified to work; direct GitHub installation is not guaranteed across npm versions.

## Maintainer release workflow

Publish a GitHub Release for a stable `vX.Y.Z` tag matching package.json. `.github/workflows/release.yml` runs on release publication and checks out the release tag. It runs `npm ci`, `npm run check`, `npm test`, `npm run build`, and `npm pack --json`, verifies the generated versioned tarball, copies it to `saf-cli-tester.tgz`, and uploads that fixed filename to the corresponding release. It does not publish to npmjs. Every stable release must have this asset before it is installable; monitor the workflow after publication. This publication-triggered workflow requires mutable releases so the asset can be attached after publication.

`main` is development state. Update commands use the latest published stable GitHub Release, never main or unpublished tags. The CLI never creates tags or releases.
