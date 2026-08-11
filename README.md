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
overwrites existing agent policy or harness configuration.

Without `--release`, GitHub's latest non-draft, non-prerelease producer release
is selected exactly once and persisted in `.agents/zukan/release-lock.json`.
An explicit `--release <tag>` may select a prerelease for an approved pilot.
Install does not silently float after that point. Reviewable updates and update
warnings are delivered by the next workflow slice rather than hidden inside
first installation.

After installation, run:

```sh
npx @zukantech/agent doctor
```

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
