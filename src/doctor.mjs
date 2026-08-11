import { lstat, readFile, readdir, readlink, realpath } from 'node:fs/promises'
import path from 'node:path'
import { PRIVATE_REPOSITORY, exactKeys, expectedProducer, parseJson, pathIsUnsafe, sha256, validateReleaseName } from './contracts.mjs'

async function requireSymlink(target, source, repository) {
  let metadata
  try { metadata = await lstat(target) } catch { throw new Error(`${path.relative(repository, target)} is missing`) }
  if (!metadata.isSymbolicLink()) throw new Error(`${path.relative(repository, target)} is not an installer-managed link`)
  const actual = path.resolve(path.dirname(target), await readlink(target))
  if (actual !== source) throw new Error(`${path.relative(repository, target)} link target has drifted`)
}

async function inventory(root) {
  const entries = await readdir(root, { recursive: true, withFileTypes: true })
  const files = new Map()
  for (const entry of entries) {
    const absolute = path.join(entry.parentPath, entry.name)
    const relative = path.relative(root, absolute).split(path.sep).join('/')
    const metadata = await lstat(absolute)
    if (metadata.isSymbolicLink() || (!metadata.isDirectory() && !metadata.isFile())) {
      throw new Error(`${relative} has an unsafe installed file type`)
    }
    if (metadata.isFile()) files.set(relative, sha256(await readFile(absolute)))
  }
  return files
}

function validateLock(lock) {
  exactKeys(lock, [
    'schemaVersion', 'kind', 'repository', 'release', 'revision', 'archiveSha256',
    'manifestSha256', 'signatureBundleSha256', 'producer', 'files',
  ], 'release lock')
  if (lock.schemaVersion !== 1 || lock.kind !== 'zukan-agent-release-lock' || lock.repository !== PRIVATE_REPOSITORY) {
    throw new Error('release lock authority is invalid')
  }
  validateReleaseName(lock.release)
  for (const [label, digest] of [
    ['revision', lock.revision], ['archive', lock.archiveSha256], ['manifest', lock.manifestSha256], ['signature bundle', lock.signatureBundleSha256],
  ]) {
    const pattern = label === 'revision' ? /^[a-f0-9]{40}$/ : /^[a-f0-9]{64}$/
    if (typeof digest !== 'string' || !pattern.test(digest)) throw new Error(`release lock ${label} is invalid`)
  }
  exactKeys(lock.producer, ['issuer', 'identity'], 'release lock producer')
  if (JSON.stringify(lock.producer) !== JSON.stringify(expectedProducer(lock.release))) {
    throw new Error('release lock producer identity is invalid')
  }
  if (!Array.isArray(lock.files) || lock.files.length === 0) throw new Error('release lock file inventory is invalid')
  const paths = new Set()
  for (const file of lock.files) {
    exactKeys(file, ['path', 'sha256'], 'release lock file')
    if (typeof file.path !== 'string' || pathIsUnsafe(file.path) || paths.has(file.path) || !/^[a-f0-9]{64}$/.test(file.sha256 ?? '')) {
      throw new Error('release lock file inventory is invalid')
    }
    paths.add(file.path)
  }
  return lock
}

export async function doctorRelease({ target }) {
  const repository = await realpath(target)
  const lockPath = path.join(repository, '.agents/zukan/release-lock.json')
  let lock
  try { lock = validateLock(parseJson(await readFile(lockPath), 'release lock')) } catch (error) {
    if (error.code === 'ENOENT') throw new Error('no Zukan release lock is installed')
    throw error
  }
  const vendor = path.join(repository, '.agents/zukan/vendor', lock.release)
  const actual = await inventory(vendor)
  const expected = new Map(lock.files.map((file) => [file.path, file.sha256]))
  if (actual.size !== expected.size) throw new Error('installed vendor inventory contains missing or untracked files')
  for (const [relative, digest] of expected) {
    if (actual.get(relative) !== digest) throw new Error(`${relative} installed file digest has drifted`)
  }
  await requireSymlink(path.join(repository, '.agents/zukan/workflow'), path.join(vendor, 'workflow'), repository)
  await requireSymlink(path.join(repository, '.agents/zukan/bin'), path.join(vendor, 'bin'), repository)
  const skills = [...new Set(lock.files.map((file) => /^skills\/([^/]+)\/SKILL\.md$/.exec(file.path)?.[1]).filter(Boolean))]
  for (const skill of skills) {
    const source = path.join(vendor, 'skills', skill)
    await requireSymlink(path.join(repository, '.agents/skills', skill), source, repository)
    await requireSymlink(path.join(repository, '.claude/skills', skill), source, repository)
  }
  return { status: 'healthy', release: lock.release, revision: lock.revision }
}
