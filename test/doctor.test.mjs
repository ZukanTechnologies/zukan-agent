import assert from 'node:assert/strict'
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { doctorRelease } from '../src/doctor.mjs'
import { sha256 } from '../src/contracts.mjs'
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
  return { target, release, github: release.github({ authorized: true }), verifySigstore: release.verifier() }
}

test('doctor proves the installed lock, payload digests, inventory, and harness links', async (t) => {
  const { target, release, github, verifySigstore } = await installedFixture(t)
  assert.deepEqual(await doctorRelease({ target, github, verifySigstore }), {
    status: 'healthy', release: release.release, revision: release.revision,
  })
})

test('doctor rejects payload drift and untracked files in the immutable vendor tree', async (t) => {
  const first = await installedFixture(t)
  await appendFile(path.join(first.target, `.agents/zukan/vendor/${first.release.release}/skills/zukan-flow/SKILL.md`), 'drift\n')
  await assert.rejects(doctorRelease(first), /digest|drift/i)

  const second = await installedFixture(t)
  await appendFile(path.join(second.target, `.agents/zukan/vendor/${second.release.release}/extra.txt`), 'extra\n')
  await assert.rejects(doctorRelease(second), /inventory|untracked/i)
})

test('doctor requires current private GitHub authorization before trusting local evidence', async (t) => {
  const fixture = await installedFixture(t)
  await assert.rejects(
    doctorRelease({
      target: fixture.target,
      github: fixture.release.github({ authorized: false }),
      verifySigstore: fixture.verifySigstore,
    }),
    /GitHub.*access|authorize/i,
  )
})

test('doctor rejects a release tag that no longer resolves to the installed revision', async (t) => {
  const fixture = await installedFixture(t)
  const github = fixture.release.github({ authorized: true })
  github.resolveTag = async () => 'b'.repeat(40)
  await assert.rejects(
    doctorRelease({ target: fixture.target, github, verifySigstore: fixture.verifySigstore }),
    /GitHub release tag.*installed revision/i,
  )
})

test('doctor rejects a coherent local lock and payload forgery without a valid producer signature', async (t) => {
  const fixture = await installedFixture(t)
  const evidence = path.join(fixture.target, `.agents/zukan/evidence/${fixture.release.release}/manifest.json`)
  const manifest = JSON.parse(await readFile(evidence, 'utf8'))
  const vendorFile = path.join(fixture.target, `.agents/zukan/vendor/${fixture.release.release}/${manifest.files[0].path}`)
  const forgedContents = Buffer.from('locally forged payload\n')
  await writeFile(vendorFile, forgedContents)
  manifest.files[0].sha256 = sha256(forgedContents)
  const forgedManifest = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`)
  await writeFile(evidence, forgedManifest)
  const lockPath = path.join(fixture.target, '.agents/zukan/release-lock.json')
  const lock = JSON.parse(await readFile(lockPath, 'utf8'))
  lock.files = manifest.files
  lock.manifestSha256 = sha256(forgedManifest)
  await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`)

  await assert.rejects(doctorRelease(fixture), /signature|producer/i)
})
