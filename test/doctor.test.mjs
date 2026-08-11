import assert from 'node:assert/strict'
import { appendFile, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { doctorRelease } from '../src/doctor.mjs'
import { installRelease } from '../src/install.mjs'
import { createFixtureRelease } from './support/fixture-release.mjs'

async function installedFixture(t) {
  const target = await mkdtemp(path.join(tmpdir(), 'zukan-agent-doctor-'))
  t.after(() => rm(target, { force: true, recursive: true }))
  await mkdir(path.join(target, '.git'))
  const release = await createFixtureRelease(t)
  await installRelease({
    target,
    requestedRelease: release.release,
    github: release.github({ authorized: true }),
    verifySigstore: release.verifier(),
  })
  return { target, release }
}

test('doctor proves the installed lock, payload digests, inventory, and harness links', async (t) => {
  const { target, release } = await installedFixture(t)
  assert.deepEqual(await doctorRelease({ target }), {
    status: 'healthy', release: release.release, revision: release.revision,
  })
})

test('doctor rejects payload drift and untracked files in the immutable vendor tree', async (t) => {
  const first = await installedFixture(t)
  await appendFile(path.join(first.target, `.agents/zukan/vendor/${first.release.release}/skills/zukan-flow/SKILL.md`), 'drift\n')
  await assert.rejects(doctorRelease({ target: first.target }), /digest|drift/i)

  const second = await installedFixture(t)
  await appendFile(path.join(second.target, `.agents/zukan/vendor/${second.release.release}/extra.txt`), 'extra\n')
  await assert.rejects(doctorRelease({ target: second.target }), /inventory|untracked/i)
})
