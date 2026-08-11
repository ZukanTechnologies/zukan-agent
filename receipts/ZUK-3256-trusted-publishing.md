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

Independent review, npm trusted-publisher registration, alpha.4 OIDC release,
and CI evidence will be appended before completion.
