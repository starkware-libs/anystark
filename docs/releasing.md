# Releasing the AnyStark packages

The published SDK is four packages that move together: `@starkware-libs/anystark-core`,
`@starkware-libs/anystark-cctp`, `@starkware-libs/anystark-react`, and
`@starkware-libs/anystark-paymaster-proxy`. `packages/contracts` is a Cairo package, so it
stays out of the npm release.

The packages publish to npm (`https://registry.npmjs.org`) under the `@starkware-libs`
scope as public packages, and each manifest's `repository` field links the published
package to this repository.

## Lockstep versioning

The four packages share a single version and release under one `vX.Y.Z` git tag.
The other three packages depend on `@starkware-libs/anystark-core` at `^X.Y.Z`; on the `0.x`
line a caret admits only that minor, so the core pin moves with every minor bump.
`scripts/bump_version.mjs` maintains this invariant and `scripts/assert_publish_versions.mjs`
enforces it in the publish workflow.

Bump policy while the packages are on `0.x`: a minor bump (`0.N.0`) covers new features and
breaking changes; a patch bump (`0.N.P`) covers fixes.

## Validate locally

The manifests point `main`/`types`/`exports` at the TypeScript source under `src/` so the
workspace resolves source during development. `npm publish` honors `publishConfig` only for
config values (`registry`, `tag`, and similar), so `scripts/prepare_publish.mjs` hoists each
package's `publishConfig` entry points to the manifest top level at publish time, pointing
the published package at the built `dist/`.

Prove the tarballs are coherent, token-free, at any time:

```bash
npm run build
npm run publish:dry
```

`publish:dry` runs `prepare_publish.mjs --verify`: it applies the hoist, runs `npm publish
--dry-run` and `npm pack --dry-run` for each package, asserts every hoisted entry-point path
is present in the packed files, and restores the manifests. The same step runs in `node.yml`
on every pull request, so exports-vs-`dist` drift surfaces before release day.

## Cut a release

1. On a branch, set the new version:

   ```bash
   node scripts/bump_version.mjs X.Y.Z
   npm run format
   ```

   This writes `X.Y.Z` into the four publishable manifests, sets the
   `@starkware-libs/anystark-core` dependency of the other three to `^X.Y.Z`, and
   syncs the lockfile.

2. Open the pull request, let CI pass, and merge it.

3. Tag the merge commit and push the tag:

   ```bash
   git tag vX.Y.Z
   git push origin vX.Y.Z
   ```

4. Approve the publish run: it waits for a required reviewer of the `publish` environment
   (Review deployments on the run's page).

Optionally create a GitHub Release from the tag afterwards for the changelog.

## What the workflow does

`.github/workflows/publish.yml` triggers on a pushed `vX.Y.Z` tag. Its `sbom` job generates one
CycloneDX SBOM of the four packages' runtime dependencies and uploads it as the run's
`sbom-vX.Y.Z` artifact. GitHub deletes artifacts after at most 90 days; to rebuild one, check
out the tag, run `npm ci --ignore-scripts`, then the job's `cyclonedx-npm` command.

The `publish` job then:

1. Checks out full history and asserts the tagged commit is an ancestor of `origin/main`, so
   only a commit that reached main can release.
2. Installs without dependency install scripts, type-checks, tests, and builds the workspace.
3. Runs `assert_publish_versions.mjs "$GITHUB_REF_NAME"` so the tag matches every publishable
   version and every core pin.
4. Runs `prepare_publish.mjs` to hoist the `publishConfig` entry points into each manifest.
5. Runs `publish_packages.mjs`, which publishes `@starkware-libs/anystark-core`, then
   `@starkware-libs/anystark-cctp`, then `@starkware-libs/anystark-react`, then
   `@starkware-libs/anystark-paymaster-proxy`, each from its own package directory, with the
   target registry taken from each manifest's `publishConfig`.

Set the release managers as the `publish` environment's required reviewers in the repository
settings: GitHub creates a missing environment on the first run, with no reviewers.

The publish job holds no npm token. `publish.yml` is each package's trusted publisher on
npmjs.com, so npm authenticates the publish through OIDC (`permissions: id-token: write`, on
Node 24 with its bundled npm), and attaches provenance while the repository is public.
`publish_packages.mjs` checks the registry with `npm view <name>@<version>` before each
publish and skips a version already present, so rerunning the job after a partial failure
resumes from where it stopped. `concurrency.cancel-in-progress: false` keeps a running
publish from being cancelled, which could otherwise leave core published without react.

## First publish of a new package

npm accepts a trusted publisher only for a package that already exists, so a package's first
version is published by hand, by a member of the `starkware-libs` npm org with 2FA on their
npm account.

1. From a clean checkout of the release commit, publish the packages:

   ```bash
   npm login
   npm ci
   npm run build
   node scripts/assert_publish_versions.mjs vX.Y.Z
   node scripts/prepare_publish.mjs
   node scripts/publish_packages.mjs
   git checkout -- packages/*/package.json
   ```

   `npm login` opens a two-hour session, and each `npm publish` asks for a 2FA confirmation.
   The last command restores the manifests that `prepare_publish.mjs` rewrote.

2. Add `publish.yml` as each package's trusted publisher, with npm 11.15.0 or later:

   ```bash
   for pkg in core cctp react paymaster-proxy; do
     npm trust github "@starkware-libs/anystark-$pkg" --repo starkware-libs/anystark \
       --file publish.yml --environment publish --allow-publish --yes
   done
   ```

   With `--environment publish`, npm accepts only publishes from that environment. The first
   call asks for 2FA. Package settings on npmjs.com offer the same configuration
   under Trusted publishing. npm expires a trusted publisher that no publish uses within two
   days, so add it right before pushing the next release tag.

3. Once that release publishes from CI, set each package's Publishing access to "Require
   two-factor authentication and disallow tokens". Trusted publishing keeps working.

## Consuming

```bash
npm install @starkware-libs/anystark-core starknet
```

`starknet` is a peer dependency of the SDK packages; install it in your own app.
