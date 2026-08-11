import assert from 'node:assert/strict'
import { lstat, mkdir, mkdtemp, readFile, readlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { installRelease } from '../src/install.mjs'
import { updateRelease } from '../src/update.mjs'
import { createFixtureRelease } from './support/fixture-release.mjs'

async function targetFixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'zukan-agent-update-'))
  t.after(() => rm(root, { force: true, recursive: true }))
  await mkdir(path.join(root, '.git'))
  return root
}

function releasesGitHub(releases, latest) {
  const byTag = new Map(releases.map((release) => [release.release, release]))
  return {
    async authorize() {},
    async resolveRelease(requested) {
      const selected = byTag.get(requested ?? latest.release)
      if (!selected) throw new Error('release not found')
      return { tagName: selected.release, draft: false, prerelease: selected.release.includes('-') }
    },
    async downloadAsset(release, name) {
      return byTag.get(release.tagName).github().downloadAsset(release, name)
    },
    async resolveTag(_repository, tag) { return byTag.get(tag).revision },
  }
}

test('update verifies and deliberately replaces the authoritative pin and harness links', async (t) => {
  const target = await targetFixture(t)
  const oldRelease = await createFixtureRelease(t, { release: 'v1.2.3', revision: 'a'.repeat(40) })
  const newRelease = await createFixtureRelease(t, {
    release: 'v1.2.4', revision: 'b'.repeat(40),
    files: {
      'skills/zukan-flow/SKILL.md': '---\nname: zukan-flow\ndescription: updated\n---\n',
      'skills/zukan-review/SKILL.md': '---\nname: zukan-review\ndescription: added\n---\n',
      'workflow/catalog.json': '{"schemaVersion":2}\n',
      'bin/evaluate-route-admission.mjs': 'export const updated = true\n',
    },
  })
  const github = releasesGitHub([oldRelease, newRelease], newRelease)
  await installRelease({ target, requestedRelease: oldRelease.release, github, verifySigstore: oldRelease.verifier() })

  const result = await updateRelease({ target, requestedRelease: newRelease.release, github, verifySigstore: async () => {} })

  assert.equal(result.status, 'updated')
  assert.equal(result.release, newRelease.release)
  const lock = JSON.parse(await readFile(path.join(target, '.agents/zukan/release-lock.json'), 'utf8'))
  assert.equal(lock.release, newRelease.release)
  assert.match(await readlink(path.join(target, '.agents/zukan/workflow')), new RegExp(`vendor/${newRelease.release}/workflow$`))
  assert.equal((await lstat(path.join(target, '.agents/skills/zukan-review'))).isSymbolicLink(), true)
  assert.equal((await lstat(path.join(target, `.agents/zukan/vendor/${oldRelease.release}`))).isDirectory(), true)
})

test('update rejects a missing pin and an unchanged selected release', async (t) => {
  const target = await targetFixture(t)
  const release = await createFixtureRelease(t, { release: 'v1.2.3' })
  const github = releasesGitHub([release], release)
  await assert.rejects(updateRelease({ target, github, verifySigstore: async () => {} }), /installed.*pin|release lock/i)
  await installRelease({ target, requestedRelease: release.release, github, verifySigstore: release.verifier() })
  await assert.rejects(updateRelease({ target, requestedRelease: release.release, github, verifySigstore: async () => {} }), /already installed|same release/i)
})

test('a failed update restores the previous pin and links and leaves no new vendor tree', async (t) => {
  const target = await targetFixture(t)
  const oldRelease = await createFixtureRelease(t, { release: 'v1.2.3', revision: 'a'.repeat(40) })
  const newRelease = await createFixtureRelease(t, { release: 'v1.2.4', revision: 'b'.repeat(40) })
  const github = releasesGitHub([oldRelease, newRelease], newRelease)
  await installRelease({ target, requestedRelease: oldRelease.release, github, verifySigstore: oldRelease.verifier() })
  const oldLock = await readFile(path.join(target, '.agents/zukan/release-lock.json'))

  await assert.rejects(
    updateRelease({ target, requestedRelease: newRelease.release, github, verifySigstore: async () => {}, fault: 'after-links' }),
    /injected update failure/i,
  )

  assert.equal((await readFile(path.join(target, '.agents/zukan/release-lock.json'))).equals(oldLock), true)
  assert.match(await readlink(path.join(target, '.agents/zukan/workflow')), new RegExp(`vendor/${oldRelease.release}/workflow$`))
  await assert.rejects(lstat(path.join(target, `.agents/zukan/vendor/${newRelease.release}`)), { code: 'ENOENT' })
})

test('update removes obsolete harness links while retaining the old immutable vendor evidence', async (t) => {
  const target = await targetFixture(t)
  const oldRelease = await createFixtureRelease(t, {
    release: 'v1.2.3', revision: 'a'.repeat(40),
    files: {
      'skills/zukan-flow/SKILL.md': 'flow\n',
      'skills/zukan-obsolete/SKILL.md': 'obsolete\n',
      'workflow/catalog.json': '{}\n',
      'bin/evaluate-route-admission.mjs': 'export {}\n',
    },
  })
  const newRelease = await createFixtureRelease(t, { release: 'v1.2.4', revision: 'b'.repeat(40) })
  const github = releasesGitHub([oldRelease, newRelease], newRelease)
  await installRelease({ target, requestedRelease: oldRelease.release, github, verifySigstore: oldRelease.verifier() })
  await updateRelease({ target, requestedRelease: newRelease.release, github, verifySigstore: async () => {} })
  await assert.rejects(lstat(path.join(target, '.agents/skills/zukan-obsolete')), { code: 'ENOENT' })
  await assert.rejects(lstat(path.join(target, '.claude/skills/zukan-obsolete')), { code: 'ENOENT' })
  assert.equal((await lstat(path.join(target, `.agents/zukan/vendor/${oldRelease.release}/skills/zukan-obsolete`))).isDirectory(), true)
})

test('new release verification failure preserves the current installation byte-for-byte', async (t) => {
  const target = await targetFixture(t)
  const oldRelease = await createFixtureRelease(t, { release: 'v1.2.3', revision: 'a'.repeat(40) })
  const newRelease = await createFixtureRelease(t, { release: 'v1.2.4', revision: 'b'.repeat(40) })
  const github = releasesGitHub([oldRelease, newRelease], newRelease)
  await installRelease({ target, requestedRelease: oldRelease.release, github, verifySigstore: oldRelease.verifier() })
  const oldLock = await readFile(path.join(target, '.agents/zukan/release-lock.json'))
  await assert.rejects(
    updateRelease({
      target, requestedRelease: newRelease.release, github,
      verifySigstore: async ({ artifact }) => {
        if (Buffer.from(artifact).equals(newRelease.manifestBytes)) throw new Error('release signature verification failed')
      },
    }),
    /signature verification failed/i,
  )
  assert.equal((await readFile(path.join(target, '.agents/zukan/release-lock.json'))).equals(oldLock), true)
  await assert.rejects(lstat(path.join(target, `.agents/zukan/vendor/${newRelease.release}`)), { code: 'ENOENT' })
})

test('an explicit rollback reuses only a retained release that still matches signed evidence', async (t) => {
  const target = await targetFixture(t)
  const oldRelease = await createFixtureRelease(t, { release: 'v1.2.3', revision: 'a'.repeat(40) })
  const newRelease = await createFixtureRelease(t, { release: 'v1.2.4', revision: 'b'.repeat(40) })
  const github = releasesGitHub([oldRelease, newRelease], newRelease)
  await installRelease({ target, requestedRelease: oldRelease.release, github, verifySigstore: oldRelease.verifier() })
  await updateRelease({ target, requestedRelease: newRelease.release, github, verifySigstore: async () => {} })

  const rollback = await updateRelease({ target, requestedRelease: oldRelease.release, github, verifySigstore: async () => {} })
  assert.equal(rollback.release, oldRelease.release)
  assert.equal(rollback.changedPaths.includes(`.agents/zukan/vendor/${oldRelease.release}`), false)
  assert.match(await readlink(path.join(target, '.agents/zukan/workflow')), new RegExp(`vendor/${oldRelease.release}/workflow$`))
})

test('rollback rejects drifted retained materialization before changing the current pin', async (t) => {
  const target = await targetFixture(t)
  const oldRelease = await createFixtureRelease(t, { release: 'v1.2.3', revision: 'a'.repeat(40) })
  const newRelease = await createFixtureRelease(t, { release: 'v1.2.4', revision: 'b'.repeat(40) })
  const github = releasesGitHub([oldRelease, newRelease], newRelease)
  await installRelease({ target, requestedRelease: oldRelease.release, github, verifySigstore: oldRelease.verifier() })
  await updateRelease({ target, requestedRelease: newRelease.release, github, verifySigstore: async () => {} })
  await rm(path.join(target, `.agents/zukan/vendor/${oldRelease.release}/workflow/catalog.json`))
  const currentLock = await readFile(path.join(target, '.agents/zukan/release-lock.json'))

  await assert.rejects(
    updateRelease({ target, requestedRelease: oldRelease.release, github, verifySigstore: async () => {} }),
    /retained release.*inventory/i,
  )
  assert.equal((await readFile(path.join(target, '.agents/zukan/release-lock.json'))).equals(currentLock), true)
  assert.match(await readlink(path.join(target, '.agents/zukan/workflow')), new RegExp(`vendor/${newRelease.release}/workflow$`))
})
