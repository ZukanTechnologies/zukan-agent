import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { hostname, tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { installRelease } from '../src/install.mjs'
import { createFixtureRelease } from './support/fixture-release.mjs'

const sha256 = (value) => createHash('sha256').update(value).digest('hex')

async function targetFixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'zukan-agent-target-'))
  t.after(() => rm(root, { force: true, recursive: true }))
  await mkdir(path.join(root, '.git'))
  return root
}

async function writeMutationLock(target, overrides = {}) {
  const lock = path.join(target, '.zukan-agent-install.lock')
  await mkdir(lock)
  await writeFile(path.join(lock, 'owner.json'), `${JSON.stringify({
    schemaVersion: 1,
    kind: 'zukan-agent-install-lock',
    hostname: hostname(),
    bootEpochMinute: null,
    pid: process.pid,
    startedAt: new Date().toISOString(),
    nonce: 'a'.repeat(36),
    ...overrides,
  })}\n`)
  return lock
}

test('an authorized install verifies immutable evidence before materializing one exact pin', async (t) => {
  const target = await targetFixture(t)
  const release = await createFixtureRelease(t, {
    release: 'v1.1.0-rc.1',
    revision: 'a'.repeat(40),
    files: {
      'skills/zukan-flow/SKILL.md': '---\nname: zukan-flow\ndescription: fixture\n---\n',
      'workflow/catalog.json': '{"schemaVersion":1}\n',
      'bin/evaluate-route-admission.mjs': 'export {}\n',
    },
  })
  const events = []

  const result = await installRelease({
    target,
    requestedRelease: release.release,
    github: release.github({ events, authorized: true }),
    verifySigstore: release.verifier({ events }),
  })

  assert.equal(result.status, 'installed')
  assert.equal(result.release, release.release)
  assert.deepEqual(events.slice(0, 7), [
    'authorize',
    'resolve-release',
    'download-manifest',
    'download-bundle',
    'download-archive',
    'resolve-tag',
    'verify-signature',
  ])
  const lock = JSON.parse(await readFile(path.join(target, '.agents/zukan/release-lock.json'), 'utf8'))
  assert.equal(lock.release, release.release)
  assert.equal(lock.revision, release.revision)
  assert.equal(lock.archiveSha256, sha256(release.archive))
  assert.equal(
    await readFile(path.join(target, `.agents/zukan/evidence/${release.release}/manifest.json`), 'utf8'),
    release.manifestBytes.toString('utf8'),
  )
  assert.equal(
    await readFile(path.join(target, `.agents/zukan/evidence/${release.release}/sigstore.json`), 'utf8'),
    '{"fixture":"sigstore-bundle"}\n',
  )
  assert.equal(
    await readFile(path.join(target, `.agents/zukan/vendor/${release.release}/skills/zukan-flow/SKILL.md`), 'utf8'),
    release.files['skills/zukan-flow/SKILL.md'],
  )
})

test('a stable install verifies and preserves signed harness certification evidence', async (t) => {
  const target = await targetFixture(t)
  const release = await createFixtureRelease(t, {
    release: 'v1.1.0',
    certified: true,
    prerelease: false,
  })
  const events = []

  await installRelease({
    target,
    github: release.github({ events, authorized: true }),
    verifySigstore: release.verifier({ events }),
  })

  assert.deepEqual(events.slice(0, 8), [
    'authorize',
    'resolve-release',
    'download-manifest',
    'download-bundle',
    'download-archive',
    'download-certification',
    'resolve-tag',
    'verify-signature',
  ])
  assert.deepEqual(
    await readFile(path.join(target, '.agents/zukan/evidence/v1.1.0/certification.json')),
    release.certificationBytes,
  )
  const lock = JSON.parse(await readFile(path.join(target, '.agents/zukan/release-lock.json'), 'utf8'))
  assert.equal(lock.certificationSha256, sha256(release.certificationBytes))

  const rejectedTarget = await targetFixture(t)
  const tampered = await createFixtureRelease(t, {
    release: 'v1.1.0',
    certified: true,
    prerelease: false,
    fault: { certificationBytes: Buffer.from('{"tampered":true}\n') },
  })
  await assert.rejects(
    installRelease({
      target: rejectedTarget,
      github: tampered.github({ authorized: true }),
      verifySigstore: tampered.verifier(),
    }),
    /certification/i,
  )
  assert.deepEqual(await readdir(rejectedTarget), ['.git'])
})

test('a stable release must use the certified manifest schema and bind its contract bytes', async (t) => {
  const uncertifiedTarget = await targetFixture(t)
  const uncertified = await createFixtureRelease(t, {
    release: 'v1.1.0',
    prerelease: false,
  })
  await assert.rejects(
    installRelease({
      target: uncertifiedTarget,
      github: uncertified.github({ authorized: true }),
      verifySigstore: uncertified.verifier(),
    }),
    /stable.*certification|certified.*schema/i,
  )
  assert.deepEqual(await readdir(uncertifiedTarget), ['.git'])

  const mislabeledTarget = await targetFixture(t)
  const mislabeled = await createFixtureRelease(t, {
    release: 'v1.1.0',
    prerelease: true,
  })
  await assert.rejects(
    installRelease({
      target: mislabeledTarget,
      requestedRelease: 'v1.1.0',
      github: mislabeled.github({ authorized: true }),
      verifySigstore: mislabeled.verifier(),
    }),
    /stable.*certification|certified.*schema/i,
  )
  assert.deepEqual(await readdir(mislabeledTarget), ['.git'])

  const driftedTarget = await targetFixture(t)
  const drifted = await createFixtureRelease(t, {
    release: 'v1.1.0',
    certified: true,
    prerelease: false,
    fault: { certificationContractDigest: 'd'.repeat(64) },
  })
  await assert.rejects(
    installRelease({
      target: driftedTarget,
      github: drifted.github({ authorized: true }),
      verifySigstore: drifted.verifier(),
    }),
    /certification contract.*digest|contract.*inventory/i,
  )
  assert.deepEqual(await readdir(driftedTarget), ['.git'])
})

test('authorization denial returns no protected content and leaves the target untouched', async (t) => {
  const target = await targetFixture(t)
  const before = await readdir(target)
  const release = await createFixtureRelease(t)

  await assert.rejects(
    installRelease({
      target,
      github: release.github({ authorized: false }),
      verifySigstore: release.verifier(),
    }),
    /GitHub.*access|authorize/i,
  )

  assert.deepEqual(await readdir(target), before)
})

test('signature, producer, tag, revision, archive, and file mismatches stop before mutation', async (t) => {
  const cases = [
    ['signature', { signatureValid: false }],
    ['producer', { producerIdentity: 'https://github.com/attacker/repo/.github/workflows/release.yml@refs/tags/v1.1.0' }],
    ['tag', { resolvedTag: 'b'.repeat(40) }],
    ['revision', { manifestRevision: 'c'.repeat(40) }],
    ['archive', { archiveBytes: Buffer.from('changed archive') }],
    ['file', { extractedFileMutation: true }],
  ]

  for (const [name, fault] of cases) {
    const target = await targetFixture(t)
    const release = await createFixtureRelease(t, { fault })
    await assert.rejects(
      installRelease({
        target,
        requestedRelease: release.release,
        github: release.github({ authorized: true }),
        verifySigstore: release.verifier(),
      }),
      new RegExp(name === 'producer' ? 'producer|identity' : name, 'i'),
    )
    assert.deepEqual(await readdir(target), ['.git'])
  }
})

test('existing agent policy and harness configuration remain byte-identical', async (t) => {
  const target = await targetFixture(t)
  const existing = {
    'AGENTS.md': 'consumer agents\n',
    'CLAUDE.md': 'consumer claude\n',
    '.claude/settings.json': '{"consumer":true}\n',
    '.codex/config.toml': 'consumer = true\n',
  }
  for (const [relative, contents] of Object.entries(existing)) {
    const file = path.join(target, relative)
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, contents)
  }
  const release = await createFixtureRelease(t)

  await installRelease({
    target,
    requestedRelease: release.release,
    github: release.github({ authorized: true }),
    verifySigstore: release.verifier(),
  })

  for (const [relative, contents] of Object.entries(existing)) {
    assert.equal(await readFile(path.join(target, relative), 'utf8'), contents)
  }
})

test('a conflicting repository pin fails preflight without partial writes', async (t) => {
  const target = await targetFixture(t)
  await mkdir(path.join(target, '.agents/zukan'), { recursive: true })
  await writeFile(path.join(target, '.agents/zukan/release-lock.json'), '{"release":"older"}\n')
  const release = await createFixtureRelease(t)

  await assert.rejects(
    installRelease({
      target,
      requestedRelease: release.release,
      github: release.github({ authorized: true }),
      verifySigstore: release.verifier(),
    }),
    /existing.*release lock|update/i,
  )

  assert.equal(await readFile(path.join(target, '.agents/zukan/release-lock.json'), 'utf8'), '{"release":"older"}\n')
  await assert.rejects(readdir(path.join(target, '.agents/zukan/vendor')), { code: 'ENOENT' })
})

test('a late filesystem failure rolls back every installer-created path', async (t) => {
  const target = await targetFixture(t)
  const claude = path.join(target, '.claude')
  await mkdir(claude)
  await chmod(claude, 0o500)
  const release = await createFixtureRelease(t)

  await assert.rejects(
    installRelease({
      target,
      requestedRelease: release.release,
      github: release.github({ authorized: true }),
      verifySigstore: release.verifier(),
    }),
    /permission denied|EACCES/i,
  )

  assert.equal((await lstat(claude)).isDirectory(), true)
  await assert.rejects(lstat(path.join(target, '.agents')), { code: 'ENOENT' })
  await assert.rejects(lstat(path.join(target, 'AGENTS.md')), { code: 'ENOENT' })
})

test('an existing repository mutation lock blocks concurrent installation without writes', async (t) => {
  const target = await targetFixture(t)
  await writeMutationLock(target)
  const release = await createFixtureRelease(t)
  await assert.rejects(
    installRelease({
      target,
      requestedRelease: release.release,
      github: release.github({ authorized: true }),
      verifySigstore: release.verifier(),
    }),
    /installation.*in progress|lock/i,
  )
  assert.deepEqual((await readdir(target)).sort(), ['.git', '.zukan-agent-install.lock'])
})

test('a lock left by a dead process is identified with safe recovery guidance', async (t) => {
  const target = await targetFixture(t)
  await writeMutationLock(target, {
    pid: 2_147_483_647,
    startedAt: new Date(Date.now() - 60_000).toISOString(),
    nonce: 'b'.repeat(36),
  })
  const release = await createFixtureRelease(t)

  await assert.rejects(
    installRelease({
      target,
      requestedRelease: release.release,
      github: release.github({ authorized: true }),
      verifySigstore: release.verifier(),
    }),
    /stale.*inspect.*remove/i,
  )
  assert.equal((await lstat(path.join(target, '.zukan-agent-install.lock'))).isDirectory(), true)
  await assert.rejects(lstat(path.join(target, '.agents')), { code: 'ENOENT' })
})

test('a malformed mutation lock fails safely with explicit recovery guidance', async (t) => {
  const target = await targetFixture(t)
  await mkdir(path.join(target, '.zukan-agent-install.lock'))
  await writeFile(path.join(target, '.zukan-agent-install.lock/owner.json'), 'not trusted metadata\n')
  const release = await createFixtureRelease(t)
  await assert.rejects(
    installRelease({
      target,
      requestedRelease: release.release,
      github: release.github({ authorized: true }),
      verifySigstore: release.verifier(),
    }),
    /inspect.*remove|stale.*lock/i,
  )
  assert.deepEqual((await readdir(target)).sort(), ['.git', '.zukan-agent-install.lock'])
})

test('an old lock with a live PID remains in progress', async (t) => {
  const target = await targetFixture(t)
  await writeMutationLock(target, {
    bootEpochMinute: null,
    pid: process.pid,
    startedAt: new Date(Date.now() - 31 * 60_000).toISOString(),
    nonce: 'c'.repeat(36),
  })
  const release = await createFixtureRelease(t)
  await assert.rejects(
    installRelease({
      target,
      requestedRelease: release.release,
      github: release.github({ authorized: true }),
      verifySigstore: release.verifier(),
    }),
    /installation.*in progress/i,
  )
  assert.equal((await lstat(path.join(target, '.zukan-agent-install.lock'))).isDirectory(), true)
})
