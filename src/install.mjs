import { randomUUID } from 'node:crypto'
import { cp, lstat, mkdir, readFile, realpath, rename, rm, rmdir, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  PRIVATE_REPOSITORY,
  RELEASE_ASSETS,
  expectedProducer,
  parseJson,
  sha256,
  validateManifest,
  validateReleaseName,
} from './contracts.mjs'
import { extractVerifiedArchive } from './archive.mjs'

async function exists(file) {
  try { return await lstat(file) } catch (error) { if (error.code === 'ENOENT') return null; throw error }
}

async function requireSafeAncestors(root, target) {
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

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function lockDocument({ manifest, manifestBytes, bundleBytes }) {
  return {
    schemaVersion: 1,
    kind: 'zukan-agent-release-lock',
    repository: PRIVATE_REPOSITORY,
    release: manifest.release,
    revision: manifest.revision,
    archiveSha256: manifest.archive.sha256,
    manifestSha256: sha256(manifestBytes),
    signatureBundleSha256: sha256(bundleBytes),
    producer: manifest.producer,
    files: manifest.files,
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
  if (await exists(vendor)) throw new Error('the selected vendor release path already exists')
  const skills = manifest.files
    .map(({ path: relative }) => /^skills\/([^/]+)\/SKILL\.md$/.exec(relative)?.[1])
    .filter(Boolean)
  const uniqueSkills = [...new Set(skills)]
  if (uniqueSkills.length === 0) throw new Error('release does not contain an installable skill catalog')
  const targets = [
    lock,
    vendor,
    path.join(repository, '.agents/zukan/workflow'),
    path.join(repository, '.agents/zukan/bin'),
    ...uniqueSkills.flatMap((skill) => [
      path.join(repository, '.agents/skills', skill),
      path.join(repository, '.claude/skills', skill),
    ]),
  ]
  for (const entry of targets) {
    await requireSafeAncestors(repository, entry)
    if (entry !== lock && entry !== vendor && await exists(entry)) {
      throw new Error(`${path.relative(repository, entry)} already exists; installation will not overwrite it`)
    }
  }
  return { repository, lock, vendor, skills: uniqueSkills }
}

async function removeEmptyParents(paths) {
  for (const directory of paths) {
    try { await rmdir(directory) } catch {}
  }
}

async function commitInstallation(plan, extracted, lockBytes) {
  const created = []
  const parentCandidates = [
    path.join(plan.repository, '.claude/skills'),
    path.join(plan.repository, '.claude'),
    path.join(plan.repository, '.agents/skills'),
    path.join(plan.repository, '.agents/zukan/vendor'),
    path.join(plan.repository, '.agents/zukan'),
    path.join(plan.repository, '.agents'),
  ]
  const createdParents = []
  for (const directory of parentCandidates) {
    if (!await exists(directory)) createdParents.push(directory)
  }
  const stage = path.join(plan.repository, '.agents/zukan', `.stage-${randomUUID()}`)
  try {
    await mkdir(path.dirname(stage), { recursive: true })
    await cp(extracted, stage, { recursive: true, errorOnExist: true, force: false })
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
      await mkdir(path.dirname(target), { recursive: true })
      await symlink(path.relative(path.dirname(target), source), target, 'dir')
      created.push(target)
    }
    const agents = path.join(plan.repository, 'AGENTS.md')
    if (!await exists(agents)) {
      const template = new URL('../templates/AGENTS.md', import.meta.url)
      await cp(template, agents, { errorOnExist: true, force: false })
      created.push(agents)
    }
    await writeFile(plan.lock, lockBytes, { flag: 'wx' })
    created.push(plan.lock)
  } catch (error) {
    await rm(stage, { force: true, recursive: true })
    for (const entry of created.reverse()) await rm(entry, { force: true, recursive: true })
    await removeEmptyParents(createdParents)
    throw error
  }
}

export async function installRelease({ target, requestedRelease, github, verifySigstore }) {
  if (!github || typeof verifySigstore !== 'function') throw new Error('installer dependencies are unavailable')
  await github.authorize(PRIVATE_REPOSITORY)
  const release = await github.resolveRelease(requestedRelease ? validateReleaseName(requestedRelease) : undefined)
  const selectedRelease = validateReleaseName(release.tagName)
  if (release.draft || (!requestedRelease && release.prerelease)) {
    throw new Error('the resolved release is not an approved stable release')
  }
  const manifestBytes = await github.downloadAsset(release, RELEASE_ASSETS.manifest)
  const bundleBytes = await github.downloadAsset(release, RELEASE_ASSETS.bundle)
  const archive = await github.downloadAsset(release, RELEASE_ASSETS.archive)
  const resolvedRevision = await github.resolveTag(PRIVATE_REPOSITORY, selectedRelease)
  const manifest = validateManifest(parseJson(manifestBytes, 'release manifest'), selectedRelease)
  if (manifest.revision !== resolvedRevision) throw new Error('release tag revision does not match the manifest revision')
  const bundle = parseJson(bundleBytes, 'Sigstore bundle')
  const producer = expectedProducer(selectedRelease)
  await verifySigstore({
    bundle,
    artifact: manifestBytes,
    certificateIssuer: producer.issuer,
    certificateIdentityURI: producer.identity,
  })
  const extracted = await extractVerifiedArchive(archive, manifest)
  try {
    const lock = lockDocument({ manifest, manifestBytes, bundleBytes })
    const lockBytes = Buffer.from(`${JSON.stringify(lock, null, 2)}\n`)
    const plan = await preflight(target, manifest, lockBytes)
    await commitInstallation(plan, extracted.root, lockBytes)
    return { status: 'installed', release: manifest.release, revision: manifest.revision }
  } finally {
    await extracted.cleanup()
  }
}
