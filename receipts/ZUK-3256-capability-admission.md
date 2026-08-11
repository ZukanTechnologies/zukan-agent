# ZUK-3256 capability admission receipt

## Authorized behavior

Extend the public bootstrap with a repository-specific policy-binding path and
a harness-neutral route-admission command without placing protected workflow
content, consumer policy, observation keys, or credentials in the npm package.

## Red evidence

- The focused admission test initially failed because no public admission
  module existed.
- CLI tests then failed because `bind-policy` and `admit` were not recognized.
- Doctor rejected a correctly augmented lock because its original exact schema
  allowed only generic release fields.

## Material choices

- `bind-policy` requires a doctor-verified installed release, exact consumer
  GitHub origin, exact release-manifest/policy/contract/integration digests, and
  an Ed25519 signature over the complete repository/release/revision envelope
  from pinned organization key `zukan-policy-v1`.
- Policy and lock mutation is serialized, bounded, and rolled back after an
  injected late failure. An existing different policy or binding fails closed.
- `--pr` reuses the existing exact-diff publication boundary; local mutation
  remains the default.
- `admit` runs doctor first and invokes only the evaluator in the verified
  installed release with fixed contract, policy, lock, and observation paths.
  Ready and blocked results preserve the evaluator exit status.

## Evidence

- `node --test test/admission.test.mjs test/cli.test.mjs test/doctor.test.mjs`
  passes the focused bind, rollback, command-routing, evaluator, and augmented
  lock cases.
- `npm test`: 70/70 pass.
- `npm run validate`: accepted the 18-file public package inventory with no
  protected path or credential-shaped content.
- Independent review found that the first `--pr` boundary did not yet allow the
  new policy path and that release update left a stale policy after replacing
  its bound lock. Permanent PR-surface and update/rollback regressions now
  prove the exact policy path is allowed. Update commits the unbound replacement
  lock before removing the release-specific policy, so abrupt termination never
  leaves a bound lock without its policy. Rollback restores policy before the
  old bound lock; injected failures on either side of policy removal restore
  both prior files.
- Independent review, CI, OIDC alpha.5 publication, and the real Zukan policy
  pilot are recorded before this slice completes.
- Producer-signer review subsequently proved the initial signature covered only
  the inner digest object. Alpha.6 now rejects release/revision relabelling and
  binds the already Sigstore-authenticated release-manifest digest; the
  permanent regression changes both the attestation and local lock identities
  without re-signing and requires rejection.
