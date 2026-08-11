import { createHash, randomUUID } from 'node:crypto'
import { cp, lstat, mkdir, readFile, readdir, readlink, rename, rm, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { PRIVATE_REPOSITORY, exactKeys, parseJson, sha256, validateReleaseName } from './contracts.mjs'
import { requireSafeAncestors } from './install.mjs'

async function exists(target) {
  try { return await lstat(target) } catch (error) { if (error.code === 'ENOENT') return null; throw error }
}

async function linkTarget(target, repository) {
  const metadata = await exists(target)
  if (!metadata?.isSymbolicLink()) throw new Error(`${path.relative(repository, target)} is not a legacy installer-managed link`)
  return path.resolve(path.dirname(target), await readlink(target))
}

async function requireLink(target, expected, repository) {
  const actual = await linkTarget(target, repository)
  if (actual !== expected) throw new Error(`${path.relative(repository, target)} legacy link target has drifted`)
}

async function safeFiles(root, label) {
  const maximumFileBytes = 16 * 1024 * 1024
  const maximumTotalBytes = 256 * 1024 * 1024
  const rootMetadata = await lstat(root)
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) throw new Error(`${label} is not a regular directory`)
  const files = []
  const entries = await readdir(root, { recursive: true, withFileTypes: true })
  if (entries.length > 2_000) throw new Error(`${label} exceeds the legacy inventory limit`)
  let totalBytes = 0
  for (const entry of entries) {
    const absolute = path.join(entry.parentPath, entry.name)
    const relative = path.relative(root, absolute).split(path.sep).join('/')
    const metadata = await lstat(absolute)
    if (metadata.isSymbolicLink() || (!metadata.isDirectory() && !metadata.isFile())) {
      throw new Error(`${label} contains an unsafe entry: ${relative}`)
    }
    if (metadata.isFile()) {
      if (metadata.size > maximumFileBytes) throw new Error(`${label} contains an oversized file: ${relative}`)
      totalBytes += metadata.size
      if (totalBytes > maximumTotalBytes) throw new Error(`${label} exceeds the legacy byte limit`)
      files.push({ absolute, relative, bytes: await readFile(absolute) })
    }
  }
  return files.sort((left, right) => left.relative < right.relative ? -1 : left.relative > right.relative ? 1 : 0)
}

async function treeDigest(root, label) {
  const hash = createHash('sha256')
  for (const file of await safeFiles(root, label)) {
    hash.update(file.relative)
    hash.update('\0')
    hash.update(file.bytes)
    hash.update('\0')
  }
  return hash.digest('hex')
}

function validateLegacyLock(lock) {
  exactKeys(lock, [
    'schemaVersion', 'repository', 'release', 'revision', 'catalogDigest',
    'releaseContractDigest', 'noticesDigest', 'skills',
  ], 'legacy release lock')
  if (lock.schemaVersion !== 1 || lock.repository !== PRIVATE_REPOSITORY) throw new Error('legacy release lock authority is invalid')
  validateReleaseName(lock.release, 'legacy release')
  if (!/^[a-f0-9]{40}$/.test(lock.revision ?? '')) throw new Error('legacy release revision is invalid')
  for (const [name, digest] of [
    ['catalog', lock.catalogDigest], ['release contract', lock.releaseContractDigest], ['notices', lock.noticesDigest],
  ]) {
    if (!/^[a-f0-9]{64}$/.test(digest ?? '')) throw new Error(`legacy ${name} digest is invalid`)
  }
  if (!Array.isArray(lock.skills) || lock.skills.length === 0) throw new Error('legacy skill inventory is invalid')
  const names = new Set()
  for (const skill of lock.skills) {
    exactKeys(skill, ['name', 'digest'], 'legacy skill')
    if (!/^zukan-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(skill.name ?? '')
      || names.has(skill.name) || !/^[a-f0-9]{64}$/.test(skill.digest ?? '')) {
      throw new Error('legacy skill inventory is invalid')
    }
    names.add(skill.name)
  }
  return lock
}

export async function validateLegacyInstallation(repository) {
  const zukan = path.join(repository, '.agents/zukan')
  const current = path.join(zukan, 'current')
  const lockPath = path.join(zukan, 'release-lock.json')
  await requireSafeAncestors(repository, lockPath)
  await requireLink(lockPath, path.join(current, 'release-lock.json'), repository)
  const vendor = await linkTarget(current, repository)
  const vendorRoot = path.join(zukan, 'vendor')
  if (path.dirname(vendor) !== vendorRoot) throw new Error('.agents/zukan/current legacy link target has drifted')
  const linkedRelease = validateReleaseName(path.basename(vendor), 'legacy current release')
  await requireSafeAncestors(repository, vendor)
  const vendorFiles = await safeFiles(vendor, 'legacy vendor')
  const legacyLockFile = vendorFiles.find(({ relative }) => relative === 'release-lock.json')
  if (!legacyLockFile) throw new Error('legacy vendor release lock is missing')
  const lockBytes = legacyLockFile.bytes
  const lock = validateLegacyLock(parseJson(lockBytes, 'legacy release lock'))
  if (lock.release !== linkedRelease) throw new Error('legacy current release differs from the lock')
  if (!(await readFile(path.join(vendor, 'release-lock.json'))).equals(lockBytes)) {
    throw new Error('legacy release lock bytes have drifted')
  }

  const lockedSkillNames = new Set(lock.skills.map(({ name }) => name))
  for (const { relative } of vendorFiles) {
    const skill = /^skills\/([^/]+)\/.+/.exec(relative)?.[1]
    if (![
      'release-lock.json', 'THIRD_PARTY_NOTICES.md', 'workflow/catalog.json', 'workflow/v1-release-contract.json',
    ].includes(relative) && (!skill || !lockedSkillNames.has(skill))) {
      throw new Error(`legacy vendor contains an untracked file: ${relative}`)
    }
  }
  const skillDirectories = (await readdir(path.join(vendor, 'skills'), { withFileTypes: true }))
    .filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()
  const lockSkills = lock.skills.map(({ name }) => name).sort()
  if (JSON.stringify(skillDirectories) !== JSON.stringify(lockSkills)) throw new Error('legacy skill directories differ from the lock')
  for (const skill of lock.skills) {
    const digest = await treeDigest(path.join(vendor, 'skills', skill.name), `legacy skill ${skill.name}`)
    if (digest !== skill.digest) throw new Error(`legacy skill ${skill.name} digest has drifted`)
  }
  for (const [relative, expected] of [
    ['workflow/catalog.json', lock.catalogDigest],
    ['workflow/v1-release-contract.json', lock.releaseContractDigest],
    ['THIRD_PARTY_NOTICES.md', lock.noticesDigest],
  ]) {
    if (sha256(await readFile(path.join(vendor, relative))) !== expected) throw new Error(`legacy ${relative} digest has drifted`)
  }

  const workflow = path.join(zukan, 'workflow')
  const workflowMetadata = await lstat(workflow)
  if (!workflowMetadata.isDirectory() || workflowMetadata.isSymbolicLink()) throw new Error('legacy workflow root has drifted')
  const workflowEntries = (await readdir(workflow)).sort()
  if (JSON.stringify(workflowEntries) !== JSON.stringify(['catalog.json', 'v1-release-contract.json'])) {
    throw new Error('legacy workflow root contains unmanaged entries')
  }
  await requireLink(path.join(workflow, 'catalog.json'), path.join(current, 'workflow/catalog.json'), repository)
  await requireLink(path.join(workflow, 'v1-release-contract.json'), path.join(current, 'workflow/v1-release-contract.json'), repository)
  for (const skill of lockSkills) {
    const source = path.join(current, 'skills', skill)
    await requireLink(path.join(repository, '.agents/skills', skill), source, repository)
    await requireLink(path.join(repository, '.claude/skills', skill), source, repository)
  }
  return { lock, lockBytes, vendor, current, lockPath, workflow, skills: lockSkills }
}

function releaseSkills(lock) {
  return [...new Set(lock.files.map(({ path: relative }) => /^skills\/([^/]+)\/SKILL\.md$/.exec(relative)?.[1]).filter(Boolean))]
}

async function replaceLink(target, source) {
  await mkdir(path.dirname(target), { recursive: true })
  const temporary = path.join(path.dirname(target), `.zukan-link-${randomUUID()}`)
  try {
    await symlink(path.relative(path.dirname(target), source), temporary, 'dir')
    await rename(temporary, target)
  } finally {
    await rm(temporary, { force: true })
  }
}

export async function commitLegacyMigration({ repository, legacy, verified, fault }) {
  const { manifest, manifestBytes, bundleBytes, certificationBytes, lockBytes, extracted } = verified
  const newVendor = path.join(repository, '.agents/zukan/vendor', manifest.release)
  const evidence = path.join(repository, '.agents/zukan/evidence', manifest.release)
  const bin = path.join(repository, '.agents/zukan/bin')
  const newSkills = releaseSkills(verified.lock)
  const oldSkillLinks = new Map(legacy.skills.flatMap((skill) => {
    const source = path.join(legacy.current, 'skills', skill)
    return [
      [path.join(repository, '.agents/skills', skill), source],
      [path.join(repository, '.claude/skills', skill), source],
    ]
  }))
  const newSkillLinks = new Map(newSkills.flatMap((skill) => {
    const source = path.join(newVendor, 'skills', skill)
    return [
      [path.join(repository, '.agents/skills', skill), source],
      [path.join(repository, '.claude/skills', skill), source],
    ]
  }))
  const targets = [newVendor, evidence, legacy.lockPath, legacy.current, legacy.workflow, bin, ...oldSkillLinks.keys(), ...newSkillLinks.keys()]
  for (const target of targets) await requireSafeAncestors(repository, target)
  if (await exists(newVendor) || await exists(evidence)) throw new Error('selected release already has retained repository state')
  if (await exists(bin)) throw new Error('.agents/zukan/bin already exists; migration will not overwrite it')
  for (const target of newSkillLinks.keys()) {
    if (!oldSkillLinks.has(target) && await exists(target)) throw new Error(`${path.relative(repository, target)} already exists; migration will not overwrite it`)
  }

  const stage = path.join(repository, '.agents/zukan', `.stage-${randomUUID()}`)
  const workflowBackup = path.join(repository, '.agents/zukan', `.legacy-workflow-${randomUUID()}`)
  let materialized = false
  let workflowBackedUp = false
  let lockReplaced = false
  let currentRemoved = false
  let binCreated = false
  const changedSkillLinks = []
  let temporaryLock
  let temporaryWorkflow
  try {
    await cp(extracted.root, stage, { recursive: true, errorOnExist: true, force: false })
    await rename(stage, newVendor)
    materialized = true
    await mkdir(evidence, { recursive: true })
    await writeFile(path.join(evidence, 'manifest.json'), manifestBytes, { flag: 'wx' })
    await writeFile(path.join(evidence, 'sigstore.json'), bundleBytes, { flag: 'wx' })
    if (certificationBytes) {
      await writeFile(path.join(evidence, 'certification.json'), certificationBytes, { flag: 'wx' })
    }

    for (const [target, source] of newSkillLinks) {
      await replaceLink(target, source)
      changedSkillLinks.push(target)
    }
    for (const target of oldSkillLinks.keys()) {
      if (!newSkillLinks.has(target)) {
        await rm(target)
        changedSkillLinks.push(target)
      }
    }
    await replaceLink(bin, path.join(newVendor, 'bin'))
    binCreated = true

    temporaryWorkflow = path.join(path.dirname(legacy.workflow), `.zukan-workflow-${randomUUID()}`)
    await symlink(path.relative(path.dirname(legacy.workflow), path.join(newVendor, 'workflow')), temporaryWorkflow, 'dir')
    await rename(legacy.workflow, workflowBackup)
    workflowBackedUp = true
    if (fault === 'after-workflow-backup') throw new Error('injected legacy migration failure after-workflow-backup')
    await rename(temporaryWorkflow, legacy.workflow)
    if (fault === 'after-links') throw new Error('injected legacy migration failure after-links')

    temporaryLock = path.join(path.dirname(legacy.lockPath), `.release-lock-${randomUUID()}`)
    await writeFile(temporaryLock, lockBytes, { flag: 'wx' })
    await rename(temporaryLock, legacy.lockPath)
    lockReplaced = true
    if (fault === 'after-lock') throw new Error('injected legacy migration failure after-lock')
    await rm(legacy.current)
    currentRemoved = true
    if (fault === 'after-current') throw new Error('injected legacy migration failure after-current')
    await rm(workflowBackup, { recursive: true })
    workflowBackedUp = false
  } catch (error) {
    await rm(stage, { force: true, recursive: true })
    if (temporaryWorkflow) await rm(temporaryWorkflow, { force: true })
    if (temporaryLock) await rm(temporaryLock, { force: true })
    if (currentRemoved && !await exists(legacy.current)) await replaceLink(legacy.current, legacy.vendor)
    if (lockReplaced) {
      await rm(legacy.lockPath, { force: true })
      await symlink(path.relative(path.dirname(legacy.lockPath), path.join(legacy.current, 'release-lock.json')), legacy.lockPath)
    }
    if (workflowBackedUp) {
      await rm(legacy.workflow, { force: true, recursive: true })
      await rename(workflowBackup, legacy.workflow)
    }
    if (binCreated) await rm(bin, { force: true })
    for (const target of changedSkillLinks.reverse()) {
      await rm(target, { force: true })
      if (oldSkillLinks.has(target)) await replaceLink(target, oldSkillLinks.get(target))
    }
    if (materialized) {
      await rm(evidence, { force: true, recursive: true })
      await rm(newVendor, { force: true, recursive: true })
    }
    throw error
  }

  const touchedSkills = [...new Set([...legacy.skills, ...newSkills])]
  return [
    '.agents/zukan/release-lock.json',
    `.agents/zukan/vendor/${manifest.release}`,
    `.agents/zukan/evidence/${manifest.release}`,
    '.agents/zukan/current',
    '.agents/zukan/workflow',
    '.agents/zukan/bin',
    ...touchedSkills.flatMap((skill) => [`.agents/skills/${skill}`, `.claude/skills/${skill}`]),
  ]
}
