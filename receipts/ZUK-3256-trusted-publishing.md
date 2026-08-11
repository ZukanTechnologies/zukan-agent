# ZUK-3256 trusted publishing receipt

## Authorized behavior

Replace the one-time interactive bootstrap publication with tokenless GitHub
OIDC trusted publishing. A GitHub release may publish only the exact package
version at a revision already contained in `main`, after the complete test and
public-package validation gates pass.

## Red evidence

The first focused test failed because no release contract or publish workflow
existed. The new tests also required the existing CI workflow to stop using
mutable action tags before the release workflow could be accepted.

## Material choices

- The workflow runs only for a published GitHub Release on a GitHub-hosted
  runner in the `npm` environment.
- Its permissions are limited to `contents: read` and `id-token: write`; there
  is no npm token, GitHub secret, or credential fallback.
- Checkout credentials are not persisted, history is complete, and every
  third-party action is pinned to an immutable commit.
- The release contract requires `v<package version>`, exact `GITHUB_SHA`, and
  containment in `origin/main` before invoking npm. Prereleases derive `next`;
  stable versions derive `latest`.
- `npm ci --ignore-scripts`, all 62 tests, and the public-package inventory
  validator run before the OIDC-aware `npm publish` process.
- Publication also passes `--ignore-scripts`, preventing lifecycle hooks from
  changing the package after the validated inventory gate.

## Evidence

- `node --test test/release-workflow.test.mjs`: 3/3 pass.
- `npm test`: 62/62 pass.
- `npm run validate`: 17-file public inventory accepted with no protected path
  or credential-shaped content.
- `git diff --check` and `node --check` on both release modules.
- Independent Codex review found one release-integrity gap: publish lifecycle
  scripts could mutate the tree after validation. A focused red test preserved
  the finding and `--ignore-scripts` closed it. The post-fix review questioned
  the full-suite count from its read-only sandbox; a normal rerun explicitly
  reported `tests 62`, `pass 62`, `fail 0`, confirming the recorded evidence.
- The first interactive package bootstrap published
  `@zukantech/agent@0.1.0-alpha.3` with registry shasum
  `4713f18164a7c845042b14f3994366aeb2d2c35a`; a clean public `npx` migration
  and unversioned online doctor both passed against a disposable real Zukan
  clone.
- PR #4 merged as `27e9e6b7f5002f24a706462c53047c851c30465e`
  after the GitHub `validate` and both Socket checks passed.
- npm trust configuration `b59d9890-5cd2-4e28-a44f-a8139cf4dd88` binds only
  `ZukanTechnologies/zukan-agent`, `publish.yml`, environment `npm`, and the
  `npm publish` permission.
- GitHub prerelease `v0.1.0-alpha.4` triggered release workflow run
  `31452681541`, which passed at the exact merged revision with no npm token.
- The public registry reports alpha.4 shasum
  `17d612f4daa7a51e7c66f6c4bbd716795b088447`, 17 files, and SLSA provenance;
  `next` is alpha.4 while `latest` remains the bootstrap alpha.3.
- A clean public-registry alpha.4 invocation reported the installed Zukan
  workflow pin healthy at producer release `v0.1.0-alpha.6`.
- npm package settings were hardened after the OIDC proof: 2FA is required and
  bypass-capable traditional publishing tokens are disallowed. The trusted
  publisher remains enabled and is unaffected by that restriction.
