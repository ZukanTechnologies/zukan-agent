# @zukantech/agent

Public, non-sensitive bootstrap for repository-scoped Zukan Technologies agent
workflows. Protected workflow content remains private and is returned only after
the installed GitHub CLI proves access to `ZukanTechnologies/agent-skills`.

```sh
gh auth login
npx @zukantech/agent install
```

The prerequisite is Node.js 22.9 or newer, npm, and a `gh` session whose GitHub
identity can read the private `ZukanTechnologies/agent-skills` repository. GitHub
organization/repository access is the sole consumer identity authority; an npm
organization membership or private npm token is neither required nor accepted
as authorization.

Use `--release <tag>` for a deliberate immutable pin. The installer verifies the
expected private producer, keyless Sigstore bundle, GitHub tag target, revision,
exact Claude Code, Codex, and OpenCode certification receipt, archive digest,
and every payload file before it changes the repository. It never
overwrites existing agent policy or harness configuration. Installation and
updates remain local by default: they do not create a branch, commit, push, or
pull request.

Without `--release`, GitHub's latest non-draft, non-prerelease producer release
is selected exactly once and persisted in `.agents/zukan/release-lock.json`.
An explicit `--release <tag>` may select a prerelease for an approved pilot.
Install does not silently float after that point.

## Deliberate updates and publication

`doctor` and operations selecting an explicit release perform a bounded,
best-effort stable-release check cached for 24 hours. Default install and update
already resolve the latest stable release exactly once and do not repeat that
lookup. A healthy older pin stays ready; the CLI reports the installed and
available versions plus an exact local update command. A network or cache
failure suppresses only the advisory notice and never invalidates a verified
pin.

```sh
# Resolve and verify the latest approved stable release, keeping changes local
npx @zukantech/agent update

# Deliberately pin or roll back to one immutable release
npx @zukantech/agent update --release v1.2.3

# Explicitly publish only the generated install/update diff
npx @zukantech/agent update --release v1.2.3 --pr
```

Repositories pinned by the pre-marketplace installer use a different,
symlinked lock layout. Migrate one only through the explicit reviewable path:

```sh
npx @zukantech/agent update --release v0.1.0-alpha.6 --migrate-legacy

# From a clean, current default branch, publish that exact migration as a PR
npx @zukantech/agent update --release v0.1.0-alpha.6 --migrate-legacy --pr
```

Legacy migration first verifies the selected signed release, then proves the
old lock, complete vendor inventory, digests, and every installer-managed link.
It preserves repository policy, harness settings, unrelated skills, and the old
immutable vendor tree. It replaces only the release lock and managed workflow,
binary, and skill links; any failure restores the legacy layout. The flag is
rejected for current installations and migration always requires an exact,
different release.

`--pr` is only for publishing the workflow bootstrap or pin change; it is not a
prerequisite for ordinary application development. It requires a clean checkout
on the repository's default branch, creates a dedicated branch, force-adds only
installer-owned paths (even when generic ignore rules cover them), snapshots the
complete staged Git tree, creates the machine-generated commit with local hooks
disabled, and requires the commit to have the identical tree before it pushes or
opens the pull request. Repository CI and PR gates remain authoritative. The CLI
refuses dirty, non-default-branch, out-of-scope, partial, or byte-mismatched diffs
before external publication.

After installation, run:

```sh
npx @zukantech/agent doctor
```

`doctor` is an online admission check: it re-proves private GitHub access,
re-verifies the persisted signed manifest, Sigstore bundle, and stable-release
certification evidence, confirms the tag still resolves to the pinned revision,
and checks the installed inventory and harness links for drift.

## Signed capability admission

Organization workflows may require authenticated GitHub, Linear, Sentry, and
repository-approved operational tooling before a route starts. The consumer
policy is repository-specific, but it is not trusted merely because it exists
in the checkout. A protected organization workflow signs the exact policy,
installed capability contract, all three harness integration declarations,
consumer repository, producer release, and revision. Bind that returned proof
locally, or publish only the bounded policy/lock diff through the existing PR
gate:

```sh
npx @zukantech/agent bind-policy \
  --policy /path/to/repository-capabilities.json \
  --attestation /path/to/capability-admission.json

npx @zukantech/agent bind-policy \
  --policy /path/to/repository-capabilities.json \
  --attestation /path/to/capability-admission.json \
  --pr
```

Binding first runs the complete online doctor, verifies the organization
Ed25519 signature over the repository, release, revision, release-manifest
digest, contract, integrations, and policy, confirms the exact GitHub repository
origin, and transactionally installs the policy plus augmented release lock.
It cannot overwrite a different policy or an existing binding.

Because the binding covers exact release bytes, updating the workflow release
removes the old repository policy in the same transaction. Rebind a freshly
signed policy before any route can be admitted on the new release.

Each harness then supplies a current signed observation envelope from a
repository-trusted observer. Admission independently re-runs doctor and invokes
the verified evaluator installed by the protected release:

```sh
npx @zukantech/agent admit \
  --route production-incident \
  --observations /path/to/current-observations.json
```

A ready result exits successfully. Missing installation, authentication,
authorization, identity membership, target access, freshness, or signature
evidence exits nonzero with the harness-native remediation. The CLI never
substitutes another tracker, telemetry source, or operations provider.

The public npm package contains generic bootstrap logic only—no Zukan skills,
marketplace payload, credentials, or protected release material.

## Trust and failure model

The installer authorizes before downloading protected assets, then verifies the
release manifest's approved repository and GitHub Actions workflow identity,
its keyless Sigstore bundle and transparency evidence, the GitHub tag's peeled
commit, signed certification digest and exact harness results, archive digest,
exact file inventory, and every file digest. Archive
paths, links, special files, expansion size, and unexpected files are rejected.
Only then is the payload staged under the harness-neutral `.agents` authority
and linked into the shared skills discovery surface plus Claude Code's adapter.
The protected release carries the same canonical skills and declared
integration contract for Claude Code, Codex, and OpenCode; consumer repository
policy remains authoritative for readiness and delivery gates.

Authorization, evidence, preflight, or mutation failures return a concise
actionable error and do not print raw `gh` output. Any paths created during a
failed mutation are rolled back; pre-existing policy and harness files remain
byte-identical.

An exclusive repository lock serializes cooperating installers, and destination
ancestors are revalidated throughout mutation. As with Git and npm themselves,
the bootstrap assumes the local repository and OS account are trusted; it does
not claim to defend against a malicious concurrent process already running as
the same user with permission to rewrite the repository.

If an unclean exit leaves `.zukan-agent-install.lock/`, the next run identifies
whether its owner is live, stale, cross-host, or malformed. Stale state is never
deleted automatically: inspect it and remove that directory only after
confirming no installer is active, then rerun the same install command.
