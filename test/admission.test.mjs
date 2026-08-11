import assert from 'node:assert/strict'
import { generateKeyPairSync, sign } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { bindCapabilityPolicy, evaluateAdmission, stableJson } from '../src/admission.mjs'
import { sha256 } from '../src/contracts.mjs'

const revision = 'a'.repeat(40)
const release = 'v0.1.0-alpha.6'

async function fixture(t) {
  const target = await mkdtemp(path.join(tmpdir(), 'zukan-agent-admission-'))
  t.after(() => rm(target, { force: true, recursive: true }))
  await mkdir(path.join(target, '.git'))
  await mkdir(path.join(target, '.agents/zukan/workflow/integrations'), { recursive: true })
  await mkdir(path.join(target, '.agents/zukan/bin'), { recursive: true })
  const contract = Buffer.from(`${JSON.stringify({
    integrations: {
      'claude-code': 'integrations/claude-code.json',
      codex: 'integrations/codex.json',
      opencode: 'integrations/opencode.json',
    },
  })}\n`)
  await writeFile(path.join(target, '.agents/zukan/workflow/v1-capability-contract.json'), contract)
  const integrationDeclarationSha256 = {}
  for (const harness of ['claude-code', 'codex', 'opencode']) {
    const bytes = Buffer.from(`${JSON.stringify({ harness })}\n`)
    await writeFile(path.join(target, `.agents/zukan/workflow/integrations/${harness}.json`), bytes)
    integrationDeclarationSha256[harness] = sha256(bytes)
  }
  const baseLock = {
    schemaVersion: 1,
    kind: 'zukan-agent-release-lock',
    repository: 'ZukanTechnologies/agent-skills',
    release,
    revision,
    archiveSha256: 'b'.repeat(64),
    manifestSha256: 'c'.repeat(64),
    signatureBundleSha256: 'd'.repeat(64),
    producer: {
      issuer: 'https://token.actions.githubusercontent.com',
      identity: `https://github.com/ZukanTechnologies/agent-skills/.github/workflows/release.yml@refs/tags/${release}`,
    },
    files: [{ path: 'workflow/catalog.json', sha256: 'e'.repeat(64) }],
  }
  await writeFile(path.join(target, '.agents/zukan/release-lock.json'), `${JSON.stringify(baseLock, null, 2)}\n`)
  const policy = Buffer.from(`${JSON.stringify({
    schemaVersion: 1,
    repository: 'ZukanTechnologies/zukan',
    trustedObservationKeys: [],
    authorizedIdentities: {},
    capabilities: [],
    routes: [],
  }, null, 2)}\n`)
  const policyFile = path.join(target, 'policy.json')
  await writeFile(policyFile, policy)
  const capabilityAdmission = {
    contractSha256: sha256(contract),
    integrationDeclarationSha256,
    repository: 'ZukanTechnologies/zukan',
    repositoryPolicySha256: sha256(policy),
  }
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const attestation = {
    schemaVersion: 1,
    kind: 'zukan-capability-admission',
    repository: 'ZukanTechnologies/zukan',
    release,
    revision,
    capabilityAdmission,
    capabilityAdmissionAttestation: {
      scheme: 'ed25519',
      keyId: 'zukan-policy-v1',
      signature: sign(null, Buffer.from(stableJson(capabilityAdmission)), privateKey).toString('base64'),
    },
  }
  const attestationFile = path.join(target, 'attestation.json')
  await writeFile(attestationFile, `${JSON.stringify(attestation, null, 2)}\n`)
  return { target, policyFile, attestationFile, publicKey }
}

test('binds only an organization-signed policy for the exact repository and installed release', async (t) => {
  const value = await fixture(t)
  const result = await bindCapabilityPolicy({
    target: value.target,
    policyFile: value.policyFile,
    attestationFile: value.attestationFile,
    repositoryIdentity: async () => 'ZukanTechnologies/zukan',
    trustedPolicyPublicKey: value.publicKey.export({ type: 'spki', format: 'der' }),
  })
  assert.deepEqual(result.changedPaths.sort(), [
    '.agents/zukan/release-lock.json',
    '.agents/zukan/repository-capabilities.json',
  ])
  const lock = JSON.parse(await readFile(path.join(value.target, '.agents/zukan/release-lock.json')))
  assert.equal(lock.capabilityAdmission.repositoryPolicySha256, sha256(await readFile(value.policyFile)))
  assert.equal(JSON.parse(await readFile(path.join(value.target, '.agents/zukan/repository-capabilities.json'))).repository, 'ZukanTechnologies/zukan')

  const forged = await fixture(t)
  const document = JSON.parse(await readFile(forged.attestationFile))
  document.capabilityAdmission.repositoryPolicySha256 = '0'.repeat(64)
  await writeFile(forged.attestationFile, `${JSON.stringify(document)}\n`)
  await assert.rejects(bindCapabilityPolicy({
    target: forged.target,
    policyFile: forged.policyFile,
    attestationFile: forged.attestationFile,
    repositoryIdentity: async () => 'ZukanTechnologies/zukan',
    trustedPolicyPublicKey: forged.publicKey.export({ type: 'spki', format: 'der' }),
  }), /signature|digest/i)
})

test('runs the verified installed evaluator with fixed policy and lock paths', async (t) => {
  const value = await fixture(t)
  await writeFile(path.join(value.target, '.agents/zukan/repository-capabilities.json'), '{}\n')
  await writeFile(path.join(value.target, '.agents/zukan/bin/evaluate-route-admission.mjs'), 'fixture\n')
  const observations = path.join(value.target, 'observations.json')
  await writeFile(observations, '{}\n')
  const calls = []
  const result = await evaluateAdmission({
    target: value.target,
    route: 'small-feature',
    observationsFile: observations,
    runner: async (command, args) => {
      calls.push([command, ...args])
      return { stdout: '{"status":"blocked"}\n', stderr: '', exitCode: 1 }
    },
  })
  assert.equal(result.exitCode, 1)
  assert.deepEqual(JSON.parse(result.output), { status: 'blocked' })
  const repository = await realpath(value.target)
  assert.deepEqual(calls[0].slice(2), [
    '--contract', path.join(repository, '.agents/zukan/workflow/v1-capability-contract.json'),
    '--route', 'small-feature',
    '--observations', observations,
    '--repository', path.join(repository, '.agents/zukan/repository-capabilities.json'),
    '--release-lock', path.join(repository, '.agents/zukan/release-lock.json'),
  ])
})

test('rolls back both policy and lock when capability binding fails late', async (t) => {
  const value = await fixture(t)
  const lockFile = path.join(value.target, '.agents/zukan/release-lock.json')
  const before = await readFile(lockFile)
  await assert.rejects(bindCapabilityPolicy({
    target: value.target,
    policyFile: value.policyFile,
    attestationFile: value.attestationFile,
    repositoryIdentity: async () => 'ZukanTechnologies/zukan',
    trustedPolicyPublicKey: value.publicKey.export({ type: 'spki', format: 'der' }),
    fault: 'after-policy',
  }), /injected capability binding failure/)
  assert.equal((await readFile(lockFile)).equals(before), true)
  await assert.rejects(readFile(path.join(value.target, '.agents/zukan/repository-capabilities.json')), { code: 'ENOENT' })
})
