# Zukan Agent Bootstrap Guide

This public repository contains only the generic `@zukantech/agent` bootstrap.
Protected Zukan workflow content remains in the private
`ZukanTechnologies/agent-skills` repository and must never be committed here.

- Linear is the planning authority; use issue-bearing branches and pull requests.
- Build behavior with tests first and preserve failing evidence in the slice receipt.
- Never commit credentials, protected skills, marketplace payloads, release archives,
  or private-repository responses.
- GitHub CLI identity and private-repository access are the only consumer
  authorization path. npm membership is not consumer authority.
- Verify producer identity, signature, tag, revision, archive digest, and every
  installed file before mutating a consumer repository.
- Preserve existing `AGENTS.md`, `CLAUDE.md`, and harness configuration unless a
  maintainer explicitly authorizes a reviewable change.
- Never commit directly to `main`; use a PR, required CI, and squash merge.

Validation: `npm test`, `npm run validate`, and `npm pack --dry-run --json`.
