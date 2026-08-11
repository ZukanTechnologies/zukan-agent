import { lstat, readFile, readdir, readlink, realpath } from 'node:fs/promises'
import path from 'node:path'
import { verifyCapabilityAdmissionSignature } from './admission.mjs'
import {
  PRIVATE_REPOSITORY,
  exactKeys,
  expectedProducer,
  parseJson,
  pathIsUnsafe,
  sha256,
  validateManifest,
  validateReleaseName,
} from './contracts.mjs'

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
  const baseFields = [
    'schemaVersion', 'kind', 'repository', 'release', 'revision', 'archiveSha256',
    'manifestSha256', 'signatureBundleSha256', 'producer', 'files',
  ]
  const hasAdmission = lock?.capabilityAdmission !== undefined
  if (hasAdmission !== (lock?.capabilityAdmissionAttestation !== undefined)) {
    throw new Error('release lock capability admission fields must appear together')
  }
  exactKeys(lock, [
    ...baseFields,
    ...(hasAdmission ? ['capabilityAdmission', 'capabilityAdmissionAttestation'] : []),
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
  if (hasAdmission) {
    exactKeys(lock.capabilityAdmission, [
      'contractSha256', 'integrationDeclarationSha256', 'releaseManifestSha256', 'repository', 'repositoryPolicySha256',
    ], 'release lock capability admission')
    exactKeys(lock.capabilityAdmission.integrationDeclarationSha256, [
      'claude-code', 'codex', 'opencode',
    ], 'release lock integration declaration digests')
    for (const digest of [
      lock.capabilityAdmission.contractSha256,
      lock.capabilityAdmission.releaseManifestSha256,
      lock.capabilityAdmission.repositoryPolicySha256,
      ...Object.values(lock.capabilityAdmission.integrationDeclarationSha256),
    ]) {
      if (typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest)) {
        throw new Error('release lock capability admission digest is invalid')
      }
    }
    if (typeof lock.capabilityAdmission.repository !== 'string'
      || !/^ZukanTechnologies\/[A-Za-z0-9._-]+$/.test(lock.capabilityAdmission.repository)) {
      throw new Error('release lock capability admission repository is invalid')
    }
    if (lock.capabilityAdmission.releaseManifestSha256 !== lock.manifestSha256) {
      throw new Error('release lock capability admission manifest digest is invalid')
    }
    exactKeys(lock.capabilityAdmissionAttestation, ['scheme', 'keyId', 'signature'], 'release lock capability admission signature')
    if (lock.capabilityAdmissionAttestation.scheme !== 'ed25519'
      || lock.capabilityAdmissionAttestation.keyId !== 'zukan-policy-v1'
      || typeof lock.capabilityAdmissionAttestation.signature !== 'string'
      || !/^[A-Za-z0-9+/]+={0,2}$/.test(lock.capabilityAdmissionAttestation.signature)) {
      throw new Error('release lock capability admission signature is invalid')
    }
  }
  return lock
}

export async function doctorRelease({ target, github, verifySigstore, trustedPolicyPublicKey }) {
  if (!github || typeof verifySigstore !== 'function') throw new Error('doctor verification dependencies are unavailable')
  await github.authorize(PRIVATE_REPOSITORY)
  const repository = await realpath(target)
  const lockPath = path.join(repository, '.agents/zukan/release-lock.json')
  let lock
  try { lock = validateLock(parseJson(await readFile(lockPath), 'release lock')) } catch (error) {
    if (error.code === 'ENOENT') throw new Error('no Zukan release lock is installed')
    throw error
  }
  if (lock.capabilityAdmission) verifyCapabilityAdmissionSignature(lock, trustedPolicyPublicKey)
  const evidence = path.join(repository, '.agents/zukan/evidence', lock.release)
  const manifestBytes = await readFile(path.join(evidence, 'manifest.json'))
  const bundleBytes = await readFile(path.join(evidence, 'sigstore.json'))
  if (sha256(manifestBytes) !== lock.manifestSha256 || sha256(bundleBytes) !== lock.signatureBundleSha256) {
    throw new Error('installed release evidence digest has drifted')
  }
  const manifest = validateManifest(parseJson(manifestBytes, 'release manifest'), lock.release)
  const bundle = parseJson(bundleBytes, 'Sigstore bundle')
  if (manifest.revision !== lock.revision
    || manifest.archive.sha256 !== lock.archiveSha256
    || JSON.stringify(manifest.producer) !== JSON.stringify(lock.producer)
    || JSON.stringify(manifest.files) !== JSON.stringify(lock.files)) {
    throw new Error('release lock does not match signed release evidence')
  }
  const producer = expectedProducer(lock.release)
  await verifySigstore({
    bundle,
    artifact: manifestBytes,
    certificateIssuer: producer.issuer,
    certificateIdentityURI: producer.identity,
  })
  if (await github.resolveTag(PRIVATE_REPOSITORY, lock.release) !== lock.revision) {
    throw new Error('current GitHub release tag does not match the installed revision')
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
