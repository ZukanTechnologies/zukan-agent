import { cp, lstat, mkdir, readFile, readdir, readlink, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { acquireInstallationLock, requireSafeAncestors } from './install.mjs'
import { doctorRelease } from './doctor.mjs'
import { parseJson, sha256 } from './contracts.mjs'
import { resolveVerifiedRelease } from './release.mjs'
import { commitLegacyMigration, validateLegacyInstallation } from './legacy.mjs'

async function exists(file) {
  try { return await lstat(file) } catch (error) { if (error.code === 'ENOENT') return null; throw error }
}

function skills(lock) {
  return [...new Set(lock.files.map(({ path: relative }) => /^skills\/([^/]+)\/SKILL\.md$/.exec(relative)?.[1]).filter(Boolean))]
}

function links(repository, vendor, names) {
  return [
    [path.join(repository, '.agents/zukan/workflow'), path.join(vendor, 'workflow')],
    [path.join(repository, '.agents/zukan/bin'), path.join(vendor, 'bin')],
    ...names.flatMap((skill) => [
      [path.join(repository, '.agents/skills', skill), path.join(vendor, 'skills', skill)],
      [path.join(repository, '.claude/skills', skill), path.join(vendor, 'skills', skill)],
    ]),
  ]
}

async function requireManagedLink(target, expected) {
  const metadata = await exists(target)
  if (!metadata?.isSymbolicLink()) throw new Error(`${target} is not an installer-managed link`)
  const actual = path.resolve(path.dirname(target), await readlink(target))
  if (actual !== expected) throw new Error(`${target} does not point to the installed release`)
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

async function verifyRetainedRelease(vendor, evidence, verified) {
  const vendorMetadata = await lstat(vendor)
  const evidenceMetadata = await lstat(evidence)
  if (!vendorMetadata.isDirectory() || vendorMetadata.isSymbolicLink()
    || !evidenceMetadata.isDirectory() || evidenceMetadata.isSymbolicLink()) {
    throw new Error('retained release materialization has an unsafe file type')
  }
  for (const [name, expected] of [['manifest.json', verified.manifestBytes], ['sigstore.json', verified.bundleBytes]]) {
    const file = path.join(evidence, name)
    const metadata = await lstat(file)
    if (!metadata.isFile() || metadata.isSymbolicLink() || !(await readFile(file)).equals(expected)) {
      throw new Error(`retained release ${name} does not match current verified evidence`)
    }
  }
  const actual = new Map()
  for (const entry of await readdir(vendor, { recursive: true, withFileTypes: true })) {
    const absolute = path.join(entry.parentPath, entry.name)
    const relative = path.relative(vendor, absolute).split(path.sep).join('/')
    const metadata = await lstat(absolute)
    if (metadata.isSymbolicLink() || (!metadata.isDirectory() && !metadata.isFile())) {
      throw new Error(`retained release ${relative} has an unsafe file type`)
    }
    if (metadata.isFile()) actual.set(relative, sha256(await readFile(absolute)))
  }
  const expected = new Map(verified.manifest.files.map((file) => [file.path, file.sha256]))
  if (actual.size !== expected.size || [...expected].some(([relative, digest]) => actual.get(relative) !== digest)) {
    throw new Error('retained release vendor inventory does not match current verified evidence')
  }
}

async function commitUpdate({ repository, oldLock, oldLockBytes, verified, fault }) {
  const { manifest, manifestBytes, bundleBytes, lockBytes, extracted } = verified
  const oldVendor = path.join(repository, '.agents/zukan/vendor', oldLock.release)
  const newVendor = path.join(repository, '.agents/zukan/vendor', manifest.release)
  const evidence = path.join(repository, '.agents/zukan/evidence', manifest.release)
  const lockPath = path.join(repository, '.agents/zukan/release-lock.json')
  const policyPath = path.join(repository, '.agents/zukan/repository-capabilities.json')
  let oldPolicyBytes = null
  if (oldLock.capabilityAdmission) {
    const policyMetadata = await lstat(policyPath)
    if (!policyMetadata.isFile() || policyMetadata.isSymbolicLink()) {
      throw new Error('the bound repository capability policy has an unsafe file type')
    }
    oldPolicyBytes = await readFile(policyPath)
    if (sha256(oldPolicyBytes) !== oldLock.capabilityAdmission.repositoryPolicySha256) {
      throw new Error('the bound repository capability policy digest has drifted')
    }
  }
  const oldSkills = skills(oldLock)
  const newSkills = skills(verified.lock)
  const oldLinks = new Map(links(repository, oldVendor, oldSkills))
  const newLinks = new Map(links(repository, newVendor, newSkills))
  const mutationTargets = [
    newVendor, evidence, lockPath, ...(oldPolicyBytes ? [policyPath] : []),
    ...oldLinks.keys(), ...newLinks.keys(),
  ]
  for (const target of mutationTargets) await requireSafeAncestors(repository, target)
  for (const [target, source] of oldLinks) await requireManagedLink(target, source)
  for (const target of newLinks.keys()) {
    if (!oldLinks.has(target) && await exists(target)) throw new Error(`${path.relative(repository, target)} already exists; update will not overwrite it`)
  }
  const vendorExists = Boolean(await exists(newVendor))
  const evidenceExists = Boolean(await exists(evidence))
  if (vendorExists !== evidenceExists) throw new Error('the selected release has incomplete retained repository state')
  const reuseMaterialization = vendorExists && evidenceExists
  if (reuseMaterialization) await verifyRetainedRelease(newVendor, evidence, verified)

  const stage = path.join(repository, '.agents/zukan', `.stage-${randomUUID()}`)
  const changed = []
  let lockReplaced = false
  let temporaryLock
  let materializationCreated = false
  let policyRemoved = false
  try {
    if (!reuseMaterialization) {
      await cp(extracted.root, stage, { recursive: true, errorOnExist: true, force: false })
      await mkdir(path.dirname(newVendor), { recursive: true })
      await rename(stage, newVendor)
      materializationCreated = true
      await mkdir(evidence, { recursive: true })
      await writeFile(path.join(evidence, 'manifest.json'), manifestBytes, { flag: 'wx' })
      await writeFile(path.join(evidence, 'sigstore.json'), bundleBytes, { flag: 'wx' })
    }

    for (const [target, source] of newLinks) {
      await replaceLink(target, source)
      changed.push(target)
    }
    for (const [target] of oldLinks) {
      if (!newLinks.has(target)) {
        await rm(target)
        changed.push(target)
      }
    }
    if (fault === 'after-links') throw new Error('injected update failure after-links')

    temporaryLock = path.join(path.dirname(lockPath), `.release-lock-${randomUUID()}`)
    await writeFile(temporaryLock, lockBytes, { flag: 'wx' })
    await rename(temporaryLock, lockPath)
    lockReplaced = true
    if (fault === 'after-lock') throw new Error('injected update failure after-lock')
    if (oldPolicyBytes) {
      await rm(policyPath)
      policyRemoved = true
    }
    if (fault === 'after-policy') throw new Error('injected update failure after-policy')
  } catch (error) {
    await rm(stage, { force: true, recursive: true })
    if (temporaryLock) await rm(temporaryLock, { force: true })
    for (const target of changed.reverse()) {
      await rm(target, { force: true, recursive: true })
      if (oldLinks.has(target)) await replaceLink(target, oldLinks.get(target))
    }
    if (policyRemoved) await writeFile(policyPath, oldPolicyBytes, { flag: 'wx' })
    if (lockReplaced || !(await readFile(lockPath)).equals(oldLockBytes)) {
      const restore = path.join(path.dirname(lockPath), `.release-lock-restore-${randomUUID()}`)
      await writeFile(restore, oldLockBytes, { flag: 'wx' })
      await rename(restore, lockPath)
    }
    if (materializationCreated) {
      await rm(evidence, { force: true, recursive: true })
      await rm(newVendor, { force: true, recursive: true })
    }
    throw error
  }

  const touchedSkills = [...new Set([...oldSkills, ...newSkills])]
  return [
    '.agents/zukan/release-lock.json',
    ...(oldPolicyBytes ? ['.agents/zukan/repository-capabilities.json'] : []),
    ...(!reuseMaterialization ? [`.agents/zukan/vendor/${manifest.release}`, `.agents/zukan/evidence/${manifest.release}`] : []),
    '.agents/zukan/workflow',
    '.agents/zukan/bin',
    ...touchedSkills.flatMap((skill) => [`.agents/skills/${skill}`, `.claude/skills/${skill}`]),
  ]
}

export async function updateRelease({ target, requestedRelease, github, verifySigstore, trustedPolicyPublicKey, migrateLegacy = false, fault }) {
  const repository = await realpath(target)
  const lockPath = path.join(repository, '.agents/zukan/release-lock.json')
  let lockMetadata
  try { lockMetadata = await lstat(lockPath) } catch (error) {
    if (error.code === 'ENOENT') throw new Error('no installed release pin exists; run npx @zukantech/agent install first')
    throw error
  }
  if (lockMetadata.isSymbolicLink()) {
    if (!migrateLegacy) throw new Error('a legacy Zukan release pin requires update --migrate-legacy with an explicit --release')
    if (!requestedRelease) throw new Error('legacy migration requires an explicit --release')
    const verified = await resolveVerifiedRelease({ requestedRelease, github, verifySigstore })
    let mutex
    try {
      mutex = await acquireInstallationLock(repository)
      const legacy = await validateLegacyInstallation(repository)
      if (verified.manifest.release === legacy.lock.release) throw new Error('legacy migration requires a different signed release')
      const changedPaths = await commitLegacyMigration({ repository, legacy, verified, fault })
      return { status: 'updated', release: verified.manifest.release, revision: verified.manifest.revision, changedPaths }
    } finally {
      try { if (mutex) await mutex.release() } finally { await verified.extracted.cleanup() }
    }
  }
  if (migrateLegacy) throw new Error('--migrate-legacy requires the recognized legacy installer layout')
  if (!lockMetadata.isFile()) throw new Error('the installed release lock is not a regular installer-managed file')
  const oldLockBytes = await readFile(lockPath)
  const oldLock = parseJson(oldLockBytes, 'installed release lock')
  await doctorRelease({ target: repository, github, verifySigstore, trustedPolicyPublicKey })
  if (requestedRelease && requestedRelease === oldLock.release) throw new Error('the selected release is already installed')
  const verified = await resolveVerifiedRelease({ requestedRelease, github, verifySigstore })
  if (verified.manifest.release === oldLock.release) {
    await verified.extracted.cleanup()
    throw new Error('the selected release is already installed')
  }
  let mutex
  try {
    mutex = await acquireInstallationLock(repository)
    if (!(await readFile(lockPath)).equals(oldLockBytes)) throw new Error('the installed release pin changed during update; retry from current state')
    const changedPaths = await commitUpdate({ repository, oldLock, oldLockBytes, verified, fault })
    return { status: 'updated', release: verified.manifest.release, revision: verified.manifest.revision, changedPaths }
  } finally {
    try { if (mutex) await mutex.release() } finally { await verified.extracted.cleanup() }
  }
}
