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
archive digest, and every payload file before it changes the repository. It never
overwrites existing agent policy or harness configuration. Installation and
updates remain local by default: they do not create a branch, commit, push, or
pull request.

Without `--release`, GitHub's latest non-draft, non-prerelease producer release
is selected exactly once and persisted in `.agents/zukan/release-lock.json`.
An explicit `--release <tag>` may select a prerelease for an approved pilot.
Install does not silently float after that point.

## Deliberate updates and publication

`install`, `update`, and `doctor` perform a bounded, best-effort stable-release
check cached for 24 hours. A healthy older pin stays ready; the CLI reports the
installed and available versions plus an exact local update command. A network
or cache failure suppresses only the advisory notice and never invalidates a
verified pin.

```sh
# Resolve and verify the latest approved stable release, keeping changes local
npx @zukantech/agent update

# Deliberately pin or roll back to one immutable release
npx @zukantech/agent update --release v1.2.3

# Explicitly publish only the generated install/update diff
npx @zukantech/agent update --release v1.2.3 --pr
```

`--pr` is only for publishing the workflow bootstrap or pin change; it is not a
prerequisite for ordinary application development. It requires a clean checkout
on the repository's default branch, creates a dedicated branch, force-adds only
installer-owned paths (even when generic ignore rules cover them), verifies the
staged path set exactly, then commits, pushes, and opens the pull request. It
refuses dirty, non-default-branch, out-of-scope, or partial diffs before any
publication write.

After installation, run:

```sh
npx @zukantech/agent doctor
```

`doctor` is an online admission check: it re-proves private GitHub access,
re-verifies the persisted signed manifest and Sigstore bundle, confirms the tag
still resolves to the pinned revision, and checks the installed inventory and
harness links for drift.

The public npm package contains generic bootstrap logic only—no Zukan skills,
marketplace payload, credentials, or protected release material.

## Trust and failure model

The installer authorizes before downloading protected assets, then verifies the
release manifest's approved repository and GitHub Actions workflow identity,
its keyless Sigstore bundle and transparency evidence, the GitHub tag's peeled
commit, archive digest, exact file inventory, and every file digest. Archive
paths, links, special files, expansion size, and unexpected files are rejected.
Only then is the payload staged and linked for generic agents plus Claude Code;
other native harness adapters remain additive pilot work.

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
