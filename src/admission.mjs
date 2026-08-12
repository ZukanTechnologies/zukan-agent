import { execFile } from 'node:child_process'
import { createPublicKey, randomUUID, verify } from 'node:crypto'
import { lstat, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { promisify } from 'node:util'
import { exactKeys, parseJson, sha256 } from './contracts.mjs'
import { acquireInstallationLock, requireSafeAncestors } from './install.mjs'

const execFileAsync = promisify(execFile)
const POLICY_PUBLIC_KEY = Buffer.from('MCowBQYDK2VwAyEA4hi2WMJEQl1gDVTByo22YU2+UWrsBDnO4DMvHYbT7W4=', 'base64')
const MAX_DOCUMENT_BYTES = 1024 * 1024

export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

async function regularBytes(file, label) {
  const metadata = await lstat(file)
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_DOCUMENT_BYTES) {
    throw new Error(`${label} must be a bounded regular file`)
  }
  return readFile(file)
}

async function defaultRepositoryIdentity(repository) {
  const { stdout } = await execFileAsync('git', ['config', '--get', 'remote.origin.url'], {
    cwd: repository,
    encoding: 'utf8',
    timeout: 30_000,
  })
  const remote = stdout.trim()
  const match = /^(?:https:\/\/github\.com\/|git@github\.com:)(ZukanTechnologies\/[A-Za-z0-9._-]+?)(?:\.git)?$/.exec(remote)
  if (!match) throw new Error('consumer repository origin is not an approved Zukan Technologies GitHub repository')
  return match[1]
}

function canonicalBase64(value, label) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new Error(`${label} is invalid`)
  const bytes = Buffer.from(value, 'base64')
  if (bytes.toString('base64') !== value) throw new Error(`${label} is invalid`)
  return bytes
}

export function verifyCapabilityAdmissionSignature(value, trustedPolicyPublicKey = POLICY_PUBLIC_KEY) {
  const signature = value.capabilityAdmissionAttestation
  exactKeys(signature, ['scheme', 'keyId', 'signature'], 'capability admission signature')
  if (signature.scheme !== 'ed25519' || signature.keyId !== 'zukan-policy-v1') {
    throw new Error('capability admission signer is not trusted')
  }
  const publicKey = createPublicKey({ key: trustedPolicyPublicKey, format: 'der', type: 'spki' })
  if (publicKey.asymmetricKeyType !== 'ed25519' || !verify(
    null,
    Buffer.from(stableJson({
      schemaVersion: 1,
      kind: 'zukan-capability-admission',
      repository: value.capabilityAdmission.repository,
      release: value.release,
      revision: value.revision,
      capabilityAdmission: value.capabilityAdmission,
    })),
    publicKey,
    canonicalBase64(signature.signature, 'capability admission signature'),
  )) throw new Error('capability admission signature is invalid')
}

async function validateBinding({ repository, policyBytes, attestation, lock, repositoryIdentity, trustedPolicyPublicKey }) {
  exactKeys(attestation, [
    'schemaVersion', 'kind', 'repository', 'release', 'revision',
    'capabilityAdmission', 'capabilityAdmissionAttestation',
  ], 'capability admission attestation')
  if (attestation.schemaVersion !== 1 || attestation.kind !== 'zukan-capability-admission') {
    throw new Error('capability admission attestation identity is invalid')
  }
  if (attestation.release !== lock.release || attestation.revision !== lock.revision) {
    throw new Error('capability admission does not match the installed release')
  }
  const actualRepository = await repositoryIdentity(repository)
  if (attestation.repository !== actualRepository) throw new Error('capability admission repository identity is invalid')
  const policy = parseJson(policyBytes, 'repository capability policy')
  const policyFields = policy?.schemaVersion === 1
    ? ['schemaVersion', 'repository', 'trustedObservationKeys', 'authorizedIdentities', 'capabilities', 'routes']
    : ['schemaVersion', 'repository', 'capabilities', 'routes']
  exactKeys(policy, policyFields, 'repository capability policy')
  if (![1, 2].includes(policy.schemaVersion) || policy.repository !== actualRepository
    || !Array.isArray(policy.capabilities) || !Array.isArray(policy.routes)
    || (policy.schemaVersion === 1 && (!Array.isArray(policy.trustedObservationKeys)
      || !policy.authorizedIdentities || typeof policy.authorizedIdentities !== 'object'
      || Array.isArray(policy.authorizedIdentities)))) {
    throw new Error('repository capability policy identity is invalid')
  }
  const admission = attestation.capabilityAdmission
  exactKeys(admission, [
    'contractSha256', 'integrationDeclarationSha256', 'releaseManifestSha256', 'repository', 'repositoryPolicySha256',
  ], 'capability admission')
  exactKeys(admission.integrationDeclarationSha256, ['claude-code', 'codex', 'opencode'], 'integration declaration digests')
  if (admission.repository !== actualRepository || admission.repositoryPolicySha256 !== sha256(policyBytes)) {
    throw new Error('capability admission repository policy digest is invalid')
  }
  if (admission.releaseManifestSha256 !== lock.manifestSha256) {
    throw new Error('capability admission release manifest digest is invalid')
  }
  const contractFile = path.join(repository, '.agents/zukan/workflow/v1-capability-contract.json')
  const contractBytes = await regularBytes(contractFile, 'capability contract')
  if (admission.contractSha256 !== sha256(contractBytes)) throw new Error('capability admission contract digest is invalid')
  const contract = parseJson(contractBytes, 'capability contract')
  exactKeys(contract.integrations, ['claude-code', 'codex', 'opencode'], 'capability contract integrations')
  for (const [harness, relative] of Object.entries(contract.integrations)) {
    if (typeof relative !== 'string' || !relative) throw new Error(`${harness} integration declaration path is invalid`)
    const file = path.resolve(path.dirname(contractFile), relative)
    const boundary = path.relative(path.dirname(contractFile), file)
    if (!boundary || boundary.startsWith('..') || path.isAbsolute(boundary)) {
      throw new Error(`${harness} integration declaration escapes the workflow`)
    }
    if (sha256(await regularBytes(file, `${harness} integration declaration`)) !== admission.integrationDeclarationSha256[harness]) {
      throw new Error(`${harness} integration declaration digest is invalid`)
    }
  }
  verifyCapabilityAdmissionSignature(attestation, trustedPolicyPublicKey)
  return { admission, signature: attestation.capabilityAdmissionAttestation }
}

export async function bindCapabilityPolicy({
  target,
  policyFile,
  attestationFile,
  repositoryIdentity = defaultRepositoryIdentity,
  trustedPolicyPublicKey = POLICY_PUBLIC_KEY,
  fault,
}) {
  const repository = await realpath(target)
  const [policyBytes, attestationBytes] = await Promise.all([
    regularBytes(path.resolve(policyFile), 'repository capability policy'),
    regularBytes(path.resolve(attestationFile), 'capability admission attestation'),
  ])
  const lockFile = path.join(repository, '.agents/zukan/release-lock.json')
  const policyTarget = path.join(repository, '.agents/zukan/repository-capabilities.json')
  const oldLockBytes = await regularBytes(lockFile, 'release lock')
  const lock = parseJson(oldLockBytes, 'release lock')
  if (lock.capabilityAdmission !== undefined || lock.capabilityAdmissionAttestation !== undefined) {
    throw new Error('the installed release lock already has a capability admission binding')
  }
  const attestation = parseJson(attestationBytes, 'capability admission attestation')
  const validated = await validateBinding({
    repository, policyBytes, attestation, lock, repositoryIdentity, trustedPolicyPublicKey,
  })
  await requireSafeAncestors(repository, policyTarget)
  await requireSafeAncestors(repository, lockFile)
  let policyExists = false
  try {
    const existing = await regularBytes(policyTarget, 'installed repository capability policy')
    policyExists = true
    if (!existing.equals(policyBytes)) throw new Error('installed repository capability policy differs from the signed policy')
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  const nextLockBytes = Buffer.from(`${JSON.stringify({
    ...lock,
    capabilityAdmission: validated.admission,
    capabilityAdmissionAttestation: validated.signature,
  }, null, 2)}\n`)
  let mutex
  const temporaryPolicy = path.join(path.dirname(policyTarget), `.repository-capabilities-${randomUUID()}`)
  const temporaryLock = path.join(path.dirname(lockFile), `.release-lock-${randomUUID()}`)
  let policyInstalled = false
  try {
    mutex = await acquireInstallationLock(repository)
    if (!(await readFile(lockFile)).equals(oldLockBytes)) throw new Error('the installed release lock changed during capability binding')
    if (!policyExists) await writeFile(temporaryPolicy, policyBytes, { flag: 'wx' })
    await writeFile(temporaryLock, nextLockBytes, { flag: 'wx' })
    if (!policyExists) {
      await rename(temporaryPolicy, policyTarget)
      policyInstalled = true
    }
    if (fault === 'after-policy') throw new Error('injected capability binding failure after-policy')
    await rename(temporaryLock, lockFile)
  } catch (error) {
    await rm(temporaryPolicy, { force: true })
    await rm(temporaryLock, { force: true })
    if (policyInstalled) await rm(policyTarget, { force: true })
    if (!(await readFile(lockFile)).equals(oldLockBytes)) await writeFile(lockFile, oldLockBytes)
    throw error
  } finally {
    if (mutex) await mutex.release()
  }
  return {
    status: 'bound',
    release: lock.release,
    revision: lock.revision,
    changedPaths: [
      '.agents/zukan/release-lock.json',
      ...(!policyExists ? ['.agents/zukan/repository-capabilities.json'] : []),
    ],
  }
}

async function defaultAdmissionRunner(command, args) {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
      timeout: 60_000,
    })
    return { stdout, stderr, exitCode: 0 }
  } catch (error) {
    if (Number.isInteger(error.code)) return { stdout: error.stdout ?? '', stderr: error.stderr ?? '', exitCode: error.code }
    throw new Error('capability admission evaluator could not be executed')
  }
}

export async function evaluateAdmission({ target, route, harness, targets = [], observationsFile, runner = defaultAdmissionRunner }) {
  if (typeof route !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(route)) throw new Error('admission route is invalid')
  const legacy = typeof observationsFile === 'string'
  if (!legacy && !['claude-code', 'codex', 'opencode'].includes(harness)) throw new Error('admission harness is invalid')
  if (legacy && (harness || targets.length)) throw new Error('legacy observations cannot be combined with harness requirements')
  if (!Array.isArray(targets) || targets.length > 32) throw new Error('admission targets are invalid')
  const selectedCapabilities = new Set()
  for (const selection of targets) {
    if (typeof selection !== 'string' || selection.length > 512 || /\s/.test(selection)) {
      throw new Error('admission target selection is invalid')
    }
    const match = /^([a-z][a-z0-9.-]{0,63})=(.+)$/.exec(selection)
    if (!match || selectedCapabilities.has(match[1])) throw new Error('admission target selection is invalid')
    selectedCapabilities.add(match[1])
  }
  const repository = await realpath(target)
  let observations
  if (legacy) {
    observations = path.resolve(observationsFile)
    await regularBytes(observations, 'capability observations')
  }
  const evaluator = path.join(repository, '.agents/zukan/bin/evaluate-route-admission.mjs')
  const contract = path.join(repository, '.agents/zukan/workflow/v1-capability-contract.json')
  const policy = path.join(repository, '.agents/zukan/repository-capabilities.json')
  const lock = path.join(repository, '.agents/zukan/release-lock.json')
  const result = await runner(process.execPath, [
    evaluator,
    '--contract', contract,
    '--route', route,
    ...(legacy ? ['--observations', observations] : [
      '--harness', harness,
      ...targets.flatMap((selection) => ['--target', selection]),
    ]),
    '--repository', policy,
    '--release-lock', lock,
  ])
  if (![0, 1].includes(result.exitCode)) {
    throw new Error(`capability admission requirements are invalid${result.stderr?.trim() ? `: ${result.stderr.trim()}` : ''}`)
  }
  const output = result.stdout.trim()
  parseJson(output, 'capability admission result')
  return { output, exitCode: result.exitCode }
}
