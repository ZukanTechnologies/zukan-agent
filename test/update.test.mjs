import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, symlink, writeFile } from 'node:fs/promises'
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

async function bindFixturePolicy(target) {
  const policy = Buffer.from('{"schemaVersion":1}\n')
  const lockFile = path.join(target, '.agents/zukan/release-lock.json')
  const lock = JSON.parse(await readFile(lockFile))
  lock.capabilityAdmission = {
    contractSha256: '1'.repeat(64),
    integrationDeclarationSha256: {
      'claude-code': '2'.repeat(64), codex: '3'.repeat(64), opencode: '4'.repeat(64),
    },
    repository: 'ZukanTechnologies/zukan',
    repositoryPolicySha256: createHash('sha256').update(policy).digest('hex'),
  }
  lock.capabilityAdmissionAttestation = {
    scheme: 'ed25519', keyId: 'zukan-policy-v1', signature: 'YQ==',
  }
  await writeFile(lockFile, `${JSON.stringify(lock, null, 2)}\n`)
  await writeFile(path.join(target, '.agents/zukan/repository-capabilities.json'), policy)
  return { lock: await readFile(lockFile), policy }
}

async function legacyTreeDigest(root) {
  const hash = createHash('sha256')
  const visit = async (current) => {
    for (const name of (await readdir(current)).sort()) {
      const absolute = path.join(current, name)
      const metadata = await lstat(absolute)
      if (metadata.isDirectory()) await visit(absolute)
      else {
        hash.update(path.relative(root, absolute).split(path.sep).join('/'))
        hash.update('\0')
        hash.update(await readFile(absolute))
        hash.update('\0')
      }
    }
  }
  await visit(root)
  return hash.digest('hex')
}

async function createLegacyInstallation(t) {
  const target = await targetFixture(t)
  const release = 'v0.1.0-alpha.4'
  const revision = 'c'.repeat(40)
  const vendor = path.join(target, '.agents/zukan/vendor', release)
  const skill = path.join(vendor, 'skills/zukan-flow')
  await mkdir(skill, { recursive: true })
  await mkdir(path.join(skill, 'agents'), { recursive: true })
  await mkdir(path.join(skill, 'references'), { recursive: true })
  await mkdir(path.join(vendor, 'workflow'), { recursive: true })
  await writeFile(path.join(skill, 'SKILL.md'), '---\nname: zukan-flow\ndescription: legacy\n---\n')
  await writeFile(path.join(skill, 'agents/openai.yaml'), 'interface:\n  display_name: Zukan Flow\n')
  await writeFile(path.join(skill, 'references/policy.md'), 'legacy policy\n')
  await writeFile(path.join(vendor, 'workflow/catalog.json'), '{"schemaVersion":1}\n')
  await writeFile(path.join(vendor, 'workflow/v1-release-contract.json'), '{"schemaVersion":1,"release":"v1"}\n')
  await writeFile(path.join(vendor, 'THIRD_PARTY_NOTICES.md'), 'legacy notices\n')
  const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')
  const lock = {
    schemaVersion: 1,
    repository: 'ZukanTechnologies/agent-skills',
    release,
    revision,
    catalogDigest: digest(await readFile(path.join(vendor, 'workflow/catalog.json'))),
    releaseContractDigest: digest(await readFile(path.join(vendor, 'workflow/v1-release-contract.json'))),
    noticesDigest: digest(await readFile(path.join(vendor, 'THIRD_PARTY_NOTICES.md'))),
    skills: [{ name: 'zukan-flow', digest: await legacyTreeDigest(skill) }],
  }
  await writeFile(path.join(vendor, 'release-lock.json'), `${JSON.stringify(lock, null, 2)}\n`)
  await mkdir(path.join(target, '.agents/zukan/workflow'), { recursive: true })
  await mkdir(path.join(target, '.agents/skills'), { recursive: true })
  await mkdir(path.join(target, '.claude/skills'), { recursive: true })
  await symlink(`vendor/${release}`, path.join(target, '.agents/zukan/current'))
  await symlink('current/release-lock.json', path.join(target, '.agents/zukan/release-lock.json'))
  await symlink('../current/workflow/catalog.json', path.join(target, '.agents/zukan/workflow/catalog.json'))
  await symlink('../current/workflow/v1-release-contract.json', path.join(target, '.agents/zukan/workflow/v1-release-contract.json'))
  await symlink('../zukan/current/skills/zukan-flow', path.join(target, '.agents/skills/zukan-flow'))
  await symlink('../../.agents/zukan/current/skills/zukan-flow', path.join(target, '.claude/skills/zukan-flow'))
  await writeFile(path.join(target, 'AGENTS.md'), 'consumer policy\n')
  await writeFile(path.join(target, '.claude/settings.json'), '{"consumer":true}\n')
  return { target, release, revision, vendor, lock }
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

test('updating a bound release safely removes its release-specific repository policy', async (t) => {
  const target = await targetFixture(t)
  const oldRelease = await createFixtureRelease(t, { release: 'v1.2.3', revision: 'a'.repeat(40) })
  const newRelease = await createFixtureRelease(t, { release: 'v1.2.4', revision: 'b'.repeat(40) })
  const github = releasesGitHub([oldRelease, newRelease], newRelease)
  await installRelease({ target, requestedRelease: oldRelease.release, github, verifySigstore: oldRelease.verifier() })
  const previous = await bindFixturePolicy(target)

  const result = await updateRelease({ target, requestedRelease: newRelease.release, github, verifySigstore: async () => {} })
  assert.ok(result.changedPaths.includes('.agents/zukan/repository-capabilities.json'))
  await assert.rejects(lstat(path.join(target, '.agents/zukan/repository-capabilities.json')), { code: 'ENOENT' })
  const lock = JSON.parse(await readFile(path.join(target, '.agents/zukan/release-lock.json')))
  assert.equal(lock.capabilityAdmission, undefined)

  const rollbackTarget = await targetFixture(t)
  await installRelease({ target: rollbackTarget, requestedRelease: oldRelease.release, github, verifySigstore: oldRelease.verifier() })
  await bindFixturePolicy(rollbackTarget)
  await assert.rejects(updateRelease({
    target: rollbackTarget,
    requestedRelease: newRelease.release,
    github,
    verifySigstore: async () => {},
    fault: 'after-lock',
  }), /injected update failure/)
  assert.equal((await readFile(path.join(rollbackTarget, '.agents/zukan/release-lock.json'))).equals(previous.lock), true)
  assert.equal((await readFile(path.join(rollbackTarget, '.agents/zukan/repository-capabilities.json'))).equals(previous.policy), true)

  await assert.rejects(updateRelease({
    target: rollbackTarget,
    requestedRelease: newRelease.release,
    github,
    verifySigstore: async () => {},
    fault: 'after-policy',
  }), /injected update failure/)
  assert.equal((await readFile(path.join(rollbackTarget, '.agents/zukan/release-lock.json'))).equals(previous.lock), true)
  assert.equal((await readFile(path.join(rollbackTarget, '.agents/zukan/repository-capabilities.json'))).equals(previous.policy), true)
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

test('explicit legacy migration verifies and replaces only installer-managed paths', async (t) => {
  const legacy = await createLegacyInstallation(t)
  const next = await createFixtureRelease(t, { release: 'v0.1.0-alpha.6', revision: 'd'.repeat(40) })
  const result = await updateRelease({
    target: legacy.target,
    requestedRelease: next.release,
    migrateLegacy: true,
    github: releasesGitHub([next], next),
    verifySigstore: next.verifier(),
  })

  assert.equal(result.status, 'updated')
  assert.equal(result.release, next.release)
  const lockMetadata = await lstat(path.join(legacy.target, '.agents/zukan/release-lock.json'))
  assert.equal(lockMetadata.isFile(), true)
  assert.equal(lockMetadata.isSymbolicLink(), false)
  await assert.rejects(lstat(path.join(legacy.target, '.agents/zukan/current')), { code: 'ENOENT' })
  assert.match(await readlink(path.join(legacy.target, '.agents/zukan/workflow')), new RegExp(`vendor/${next.release}/workflow$`))
  assert.match(await readlink(path.join(legacy.target, '.agents/zukan/bin')), new RegExp(`vendor/${next.release}/bin$`))
  assert.equal((await lstat(legacy.vendor)).isDirectory(), true)
  assert.equal(await readFile(path.join(legacy.target, 'AGENTS.md'), 'utf8'), 'consumer policy\n')
  assert.equal(await readFile(path.join(legacy.target, '.claude/settings.json'), 'utf8'), '{"consumer":true}\n')
  assert.equal(result.changedPaths.includes('AGENTS.md'), false)
  assert.equal(result.changedPaths.includes('.claude/settings.json'), false)
})

test('legacy migration requires an explicit flag and exact legacy integrity', async (t) => {
  const legacy = await createLegacyInstallation(t)
  const next = await createFixtureRelease(t, { release: 'v0.1.0-alpha.6' })
  const options = {
    target: legacy.target,
    requestedRelease: next.release,
    github: releasesGitHub([next], next),
    verifySigstore: next.verifier(),
  }
  await assert.rejects(updateRelease(options), /--migrate-legacy/i)
  assert.equal((await lstat(path.join(legacy.target, '.agents/zukan/release-lock.json'))).isSymbolicLink(), true)

  await writeFile(path.join(legacy.vendor, 'THIRD_PARTY_NOTICES.md'), 'drifted notices\n')
  await assert.rejects(updateRelease({ ...options, migrateLegacy: true }), /legacy.*digest|digest.*legacy/i)
  assert.equal((await lstat(path.join(legacy.target, '.agents/zukan/release-lock.json'))).isSymbolicLink(), true)
  await assert.rejects(lstat(path.join(legacy.target, `.agents/zukan/vendor/${next.release}`)), { code: 'ENOENT' })
})

test('legacy migration rejects unlocked vendor files and a current link outside the vendor root', async (t) => {
  const next = await createFixtureRelease(t, { release: 'v0.1.0-alpha.6' })

  await t.test('unlocked vendor file', async (t) => {
    const legacy = await createLegacyInstallation(t)
    await writeFile(path.join(legacy.vendor, 'skills/untracked.txt'), 'not covered by a skill digest\n')
    await assert.rejects(updateRelease({
      target: legacy.target, requestedRelease: next.release, migrateLegacy: true,
      github: releasesGitHub([next], next), verifySigstore: next.verifier(),
    }), /untracked file.*skills\/untracked\.txt/i)
  })

  await t.test('current link escape', async (t) => {
    const legacy = await createLegacyInstallation(t)
    await rm(path.join(legacy.target, '.agents/zukan/current'))
    await symlink('../../outside', path.join(legacy.target, '.agents/zukan/current'))
    await assert.rejects(updateRelease({
      target: legacy.target, requestedRelease: next.release, migrateLegacy: true,
      github: releasesGitHub([next], next), verifySigstore: next.verifier(),
    }), /current.*drifted/i)
  })
})

test('failed legacy migration restores every old link and removes new materialization', async (t) => {
  for (const fault of ['after-workflow-backup', 'after-links', 'after-lock', 'after-current']) {
    await t.test(fault, async (t) => {
      const legacy = await createLegacyInstallation(t)
      const next = await createFixtureRelease(t, { release: 'v0.1.0-alpha.6' })
      await assert.rejects(updateRelease({
        target: legacy.target,
        requestedRelease: next.release,
        migrateLegacy: true,
        github: releasesGitHub([next], next),
        verifySigstore: next.verifier(),
        fault,
      }), new RegExp(`injected.*${fault}`, 'i'))

      assert.equal(await readlink(path.join(legacy.target, '.agents/zukan/current')), `vendor/${legacy.release}`)
      assert.equal(await readlink(path.join(legacy.target, '.agents/zukan/release-lock.json')), 'current/release-lock.json')
      assert.equal(await readlink(path.join(legacy.target, '.agents/zukan/workflow/catalog.json')), '../current/workflow/catalog.json')
      assert.equal(await readlink(path.join(legacy.target, '.agents/zukan/workflow/v1-release-contract.json')), '../current/workflow/v1-release-contract.json')
      assert.equal(await readlink(path.join(legacy.target, '.agents/skills/zukan-flow')), '../zukan/current/skills/zukan-flow')
      assert.equal(await readlink(path.join(legacy.target, '.claude/skills/zukan-flow')), '../../.agents/zukan/current/skills/zukan-flow')
      await assert.rejects(lstat(path.join(legacy.target, '.agents/zukan/bin')), { code: 'ENOENT' })
      await assert.rejects(lstat(path.join(legacy.target, `.agents/zukan/vendor/${next.release}`)), { code: 'ENOENT' })
      await assert.rejects(lstat(path.join(legacy.target, `.agents/zukan/evidence/${next.release}`)), { code: 'ENOENT' })
    })
  }
})
