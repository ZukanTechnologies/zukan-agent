import { randomUUID } from 'node:crypto'
import { cp, lstat, mkdir, readFile, realpath, rename, rm, rmdir, symlink, writeFile } from 'node:fs/promises'
import { hostname, uptime } from 'node:os'
import path from 'node:path'
import {
  exactKeys,
  parseJson,
} from './contracts.mjs'
import { resolveVerifiedRelease } from './release.mjs'

async function exists(file) {
  try { return await lstat(file) } catch (error) { if (error.code === 'ENOENT') return null; throw error }
}

export async function requireSafeAncestors(root, target) {
  const canonicalRoot = await realpath(root)
  const relative = path.relative(canonicalRoot, target)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('installation target escapes the repository')
  }
  let current = canonicalRoot
  const parts = relative.split(path.sep)
  for (let index = 0; index < parts.length - 1; index += 1) {
    current = path.join(current, parts[index])
    const entry = await exists(current)
    if (!entry) break
    if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error(`${path.relative(root, current)} is an unsafe installation ancestor`)
  }
}

async function preflight(target, manifest, lockBytes) {
  const repository = await realpath(target)
  const git = await exists(path.join(repository, '.git'))
  if (!git) throw new Error('install must run from a repository root')
  const lock = path.join(repository, '.agents/zukan/release-lock.json')
  const existingLock = await exists(lock)
  if (existingLock) {
    if (!existingLock.isFile() || !(await readFile(lock)).equals(lockBytes)) {
      throw new Error('an existing different release lock requires the reviewable update workflow')
    }
    throw new Error('the selected release is already installed')
  }
  const vendor = path.join(repository, '.agents/zukan/vendor', manifest.release)
  const evidence = path.join(repository, '.agents/zukan/evidence', manifest.release)
  const manifestEvidence = path.join(evidence, 'manifest.json')
  const bundleEvidence = path.join(evidence, 'sigstore.json')
  const certificationEvidence = manifest.schemaVersion === 2 ? path.join(evidence, 'certification.json') : null
  if (await exists(vendor)) throw new Error('the selected vendor release path already exists')
  if (await exists(evidence)) throw new Error('the selected release evidence path already exists')
  const skills = manifest.files
    .map(({ path: relative }) => /^skills\/([^/]+)\/SKILL\.md$/.exec(relative)?.[1])
    .filter(Boolean)
  const uniqueSkills = [...new Set(skills)]
  if (uniqueSkills.length === 0) throw new Error('release does not contain an installable skill catalog')
  const targets = [
    lock,
    vendor,
    manifestEvidence,
    bundleEvidence,
    ...(certificationEvidence ? [certificationEvidence] : []),
    path.join(repository, '.agents/zukan/workflow'),
    path.join(repository, '.agents/zukan/bin'),
    ...uniqueSkills.flatMap((skill) => [
      path.join(repository, '.agents/skills', skill),
      path.join(repository, '.claude/skills', skill),
    ]),
  ]
  for (const entry of targets) {
    await requireSafeAncestors(repository, entry)
    if (entry !== lock && entry !== vendor && entry !== manifestEvidence && entry !== bundleEvidence && entry !== certificationEvidence && await exists(entry)) {
      throw new Error(`${path.relative(repository, entry)} already exists; installation will not overwrite it`)
    }
  }
  return { repository, lock, vendor, evidence, manifestEvidence, bundleEvidence, certificationEvidence, targets, skills: uniqueSkills }
}

async function removeEmptyParents(paths) {
  for (const directory of paths) {
    try { await rmdir(directory) } catch {}
  }
}

async function assertAncestorsSafe(plan) {
  for (const target of plan.targets) await requireSafeAncestors(plan.repository, target)
}

async function commitInstallation(plan, extracted, manifestBytes, bundleBytes, certificationBytes, lockBytes) {
  const created = []
  const parentCandidates = [
    path.join(plan.repository, '.claude/skills'),
    path.join(plan.repository, '.claude'),
    path.join(plan.repository, '.agents/skills'),
    path.join(plan.repository, '.agents/zukan/vendor'),
    plan.evidence,
    path.dirname(plan.evidence),
    path.join(plan.repository, '.agents/zukan'),
    path.join(plan.repository, '.agents'),
  ]
  const createdParents = []
  for (const directory of parentCandidates) {
    if (!await exists(directory)) createdParents.push(directory)
  }
  const stage = path.join(plan.repository, '.agents/zukan', `.stage-${randomUUID()}`)
  let agentsCreated = false
  try {
    await assertAncestorsSafe(plan)
    await mkdir(path.dirname(stage), { recursive: true })
    await cp(extracted, stage, { recursive: true, errorOnExist: true, force: false })
    await assertAncestorsSafe(plan)
    await mkdir(path.dirname(plan.vendor), { recursive: true })
    await rename(stage, plan.vendor)
    created.push(plan.vendor)

    const links = [
      [path.join(plan.repository, '.agents/zukan/workflow'), path.join(plan.vendor, 'workflow')],
      [path.join(plan.repository, '.agents/zukan/bin'), path.join(plan.vendor, 'bin')],
      ...plan.skills.flatMap((skill) => [
        [path.join(plan.repository, '.agents/skills', skill), path.join(plan.vendor, 'skills', skill)],
        [path.join(plan.repository, '.claude/skills', skill), path.join(plan.vendor, 'skills', skill)],
      ]),
    ]
    for (const [target, source] of links) {
      await assertAncestorsSafe(plan)
      await mkdir(path.dirname(target), { recursive: true })
      await symlink(path.relative(path.dirname(target), source), target, 'dir')
      created.push(target)
    }
    const agents = path.join(plan.repository, 'AGENTS.md')
    if (!await exists(agents)) {
      await assertAncestorsSafe(plan)
      const template = new URL('../templates/AGENTS.md', import.meta.url)
      await cp(template, agents, { errorOnExist: true, force: false })
      created.push(agents)
      agentsCreated = true
    }
    await assertAncestorsSafe(plan)
    await mkdir(plan.evidence, { recursive: true })
    await writeFile(plan.manifestEvidence, manifestBytes, { flag: 'wx' })
    created.push(plan.manifestEvidence)
    await assertAncestorsSafe(plan)
    await writeFile(plan.bundleEvidence, bundleBytes, { flag: 'wx' })
    created.push(plan.bundleEvidence)
    if (certificationBytes) {
      await assertAncestorsSafe(plan)
      await writeFile(plan.certificationEvidence, certificationBytes, { flag: 'wx' })
      created.push(plan.certificationEvidence)
    }
    await assertAncestorsSafe(plan)
    await writeFile(plan.lock, lockBytes, { flag: 'wx' })
    created.push(plan.lock)
  } catch (error) {
    await rm(stage, { force: true, recursive: true })
    for (const entry of created.reverse()) await rm(entry, { force: true, recursive: true })
    await removeEmptyParents(createdParents)
    throw error
  }
  return { agentsCreated }
}

export async function acquireInstallationLock(target) {
  const repository = await realpath(target)
  const lockDirectory = path.join(repository, '.zukan-agent-install.lock')
  const ownerPath = path.join(lockDirectory, 'owner.json')
  try {
    await mkdir(lockDirectory, { mode: 0o700 })
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
    await describeExistingLock(lockDirectory)
  }
  const owner = {
    schemaVersion: 1,
    kind: 'zukan-agent-install-lock',
    hostname: hostname(),
    bootEpochMinute: currentBootEpochMinute(),
    pid: process.pid,
    startedAt: new Date().toISOString(),
    nonce: randomUUID(),
  }
  try {
    await writeFile(ownerPath, `${JSON.stringify(owner)}\n`, { flag: 'wx', mode: 0o600 })
  } catch (error) {
    await rmdir(lockDirectory)
    throw error
  }
  return {
    async release() {
      let current
      try { current = parseJson(await readFile(ownerPath), 'installation lock') } catch { return }
      if (current.nonce !== owner.nonce) return
      await rm(ownerPath)
      await rmdir(lockDirectory)
    },
  }
}

function currentBootEpochMinute() {
  try { return Math.floor((Date.now() / 1000 - uptime()) / 60) } catch { return null }
}

function lockIsLive(owner) {
  if (owner.hostname !== hostname()) return null
  const currentBoot = currentBootEpochMinute()
  if (owner.bootEpochMinute !== null && currentBoot !== null && owner.bootEpochMinute !== currentBoot) return false
  try {
    process.kill(owner.pid, 0)
    return true
  } catch (error) {
    if (error.code === 'ESRCH') return false
    if (error.code === 'EPERM') return true
    throw error
  }
}

async function describeExistingLock(lockDirectory) {
  try {
    const metadata = await lstat(lockDirectory)
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error('invalid lock directory')
    const ownerPath = path.join(lockDirectory, 'owner.json')
    const ownerMetadata = await lstat(ownerPath)
    if (!ownerMetadata.isFile() || ownerMetadata.isSymbolicLink() || ownerMetadata.size > 4_096) throw new Error('invalid lock owner')
    const owner = parseJson(await readFile(ownerPath), 'installation lock')
    exactKeys(owner, ['schemaVersion', 'kind', 'hostname', 'bootEpochMinute', 'pid', 'startedAt', 'nonce'], 'installation lock')
    if (owner.schemaVersion !== 1
      || owner.kind !== 'zukan-agent-install-lock'
      || typeof owner.hostname !== 'string'
      || (owner.bootEpochMinute !== null && !Number.isSafeInteger(owner.bootEpochMinute))
      || !Number.isSafeInteger(owner.pid) || owner.pid <= 0
      || typeof owner.startedAt !== 'string' || Number.isNaN(Date.parse(owner.startedAt))
      || typeof owner.nonce !== 'string' || owner.nonce.length < 16 || owner.nonce.length > 128) {
      throw new Error('invalid lock metadata')
    }
    const live = lockIsLive(owner)
    if (live === true) throw new Error('another Zukan agent installation is in progress')
    if (live === null) throw new Error('the repository mutation lock belongs to another host; inspect it before manual removal')
    throw new Error('a stale Zukan installation lock remains; inspect and remove .zukan-agent-install.lock only after confirming no installer is active')
  } catch (error) {
    if (/another Zukan|another host|stale Zukan/.test(error.message)) throw error
    throw new Error('the repository has an unreadable stale installation lock; inspect and remove .zukan-agent-install.lock only after confirming no installer is active')
  }
}

export async function installRelease({ target, requestedRelease, github, verifySigstore }) {
  const verified = await resolveVerifiedRelease({ requestedRelease, github, verifySigstore })
  const { manifest, manifestBytes, bundleBytes, certificationBytes, lockBytes, extracted } = verified
  let mutex
  try {
    mutex = await acquireInstallationLock(target)
    const plan = await preflight(target, manifest, lockBytes)
    const committed = await commitInstallation(plan, extracted.root, manifestBytes, bundleBytes, certificationBytes, lockBytes)
    const changedPaths = [
      '.agents/zukan/release-lock.json',
      `.agents/zukan/vendor/${manifest.release}`,
      `.agents/zukan/evidence/${manifest.release}`,
      '.agents/zukan/workflow',
      '.agents/zukan/bin',
      ...plan.skills.flatMap((skill) => [`.agents/skills/${skill}`, `.claude/skills/${skill}`]),
    ]
    if (committed.agentsCreated) changedPaths.push('AGENTS.md')
    return { status: 'installed', release: manifest.release, revision: manifest.revision, changedPaths }
  } finally {
    try {
      if (mutex) await mutex.release()
    } finally {
      await extracted.cleanup()
    }
  }
}
