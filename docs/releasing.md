# Releasing saf-cli-tester

## Release model and installation

- `main` is the development state.
- GitHub Releases are stable versions.
- The stable release asset is always named `saf-cli-tester.tgz`.
- `update-check` and `update` use the latest published stable GitHub Release, not `main`.

Latest stable (recommended):

```sh
npm install -g https://github.com/rflx/saf-cli-tester/releases/latest/download/saf-cli-tester.tgz
```

Specific stable version (example):

```sh
npm install -g https://github.com/rflx/saf-cli-tester/releases/download/v0.2.0/saf-cli-tester.tgz
```

Development/main installation:

```sh
npm install -g github:rflx/saf-cli-tester
```

This installs development/main and is not the recommended stable installation path.

## Release procedure

### Step 1: Ensure main is current and clean

```sh
git switch main
git pull
git status
```

Proceed only with a clean working tree and the intended release changes on `main`.

### Step 2: Run validation

```sh
npm run check
npm test
npm run build
npm pack --dry-run
git diff --check
```

### Step 3: Choose the release version

Use semantic versioning:

- Patch: `0.1.0` → `0.1.1` for compatible fixes.
- Minor: `0.1.0` → `0.2.0` for new functionality; before 1.0, minor releases may include breaking changes.
- Major: move to `1.0.0` when the public interface is ready for stability; after 1.0, use major releases for incompatible changes.

Do not bump the version at the start of normal development. Choose and bump the version when preparing the release. The remaining examples use `v0.2.0`; substitute the chosen version consistently.

### Step 4: Update the version without creating a tag

Run one of:

```sh
npm version patch --no-git-tag-version
# or
npm version minor --no-git-tag-version
# or
npm version major --no-git-tag-version
```

Verify the chosen version in `package.json` and `package-lock.json`:

```sh
git diff -- package.json package-lock.json
```

### Step 5: Run full validation again

```sh
npm run check
npm test
npm run build
npm pack --dry-run
git diff --check
```

### Step 6: Commit and push the release version to main

```sh
git add package.json package-lock.json
git commit -m "Release v0.2.0"
git push origin main
```

### Step 7: Create and push an annotated tag

The tag must be `v` followed by the exact `package.json` version. Verify it points to the intended main commit before pushing:

```sh
git tag -a v0.2.0 -m "Release v0.2.0"
git rev-parse main
git rev-parse 'v0.2.0^{commit}'
git show --no-patch v0.2.0
git push origin v0.2.0
```

The two commit hashes must match.

### Step 8: Create the GitHub Release manually

1. Open **Releases** → **Draft a new release**.
2. Choose the existing tag, e.g. `v0.2.0`.
3. Set the title, e.g. `v0.2.0`, and add release notes.
4. Do not mark a stable release as a prerelease; mark it as the latest release when it should be the stable update target.
5. Publish the release.

**Do not manually upload the tarball.** The release must allow the workflow to attach its asset after publication.

### Step 9: Let the release workflow build the asset

Publishing triggers [`.github/workflows/release.yml`](../.github/workflows/release.yml). The workflow:

1. Checks out the release tag and verifies it matches the stable package version.
2. Runs `npm ci`.
3. Runs `npm run check`.
4. Runs `npm test`.
5. Runs `npm run build`.
6. Runs `npm pack` (with `--json`) and verifies the versioned tarball.
7. Creates `saf-cli-tester.tgz` by copying the packed tarball.
8. Uploads it to the GitHub Release.

### Step 10: Verify publication

Wait for the workflow to be green and verify the Release contains `saf-cli-tester.tgz`.

### Step 11: Test stable installation

Prefer a non-development machine:

```sh
npm install -g https://github.com/rflx/saf-cli-tester/releases/latest/download/saf-cli-tester.tgz
saf-cli-tester --version
saf-cli-tester --help
saf-cli-tester update-check
```

Verify the installed version matches the release and `update-check` reports it is current.

### Step 12: Test a real upgrade

On a machine with an older globally installed stable version, run:

```sh
saf-cli-tester update-check
saf-cli-tester update
saf-cli-tester --version
```

Verify the newer stable release is detected, installed, and reported by `--version`.
