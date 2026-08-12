import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runCli } from '../src/cli.mjs'

test('CLI routes install, update, and doctor to the current repository', async () => {
  const calls = []
  const dependencies = {
    cwd: () => '/consumer',
    install: async (options) => { calls.push(['install', options.target, options.requestedRelease]); return { status: 'installed', release: 'v1.2.3', revision: 'a'.repeat(40), changedPaths: ['.agents/zukan/release-lock.json'] } },
    update: async (options) => { calls.push(['update', options.target, options.requestedRelease]); return { status: 'updated', release: 'v1.2.4', revision: 'b'.repeat(40), changedPaths: ['.agents/zukan/release-lock.json'] } },
    doctor: async (options) => { calls.push(['doctor', options.target]); return { status: 'healthy', release: 'v1.2.3', revision: 'a'.repeat(40) } },
    checkForUpdate: async (options) => { calls.push(['check', options.installedRelease]); return { status: 'current' } },
  }
  assert.match(await runCli(['install', '--release', 'v1.2.3'], dependencies), /Installed v1.2.3/)
  assert.match(await runCli(['update', '--release', 'v1.2.4'], dependencies), /Updated.*v1.2.4/i)
  assert.match(await runCli(['doctor'], dependencies), /healthy.*v1.2.3/i)
  assert.deepEqual(calls, [
    ['install', '/consumer', 'v1.2.3'], ['check', 'v1.2.3'],
    ['update', '/consumer', 'v1.2.4'], ['check', 'v1.2.4'],
    ['doctor', '/consumer'], ['check', 'v1.2.3'],
  ])
})

test('CLI rejects unknown flags and missing pins without mutation', async () => {
  let mutations = 0
  const dependencies = { install: async () => { mutations += 1 }, update: async () => { mutations += 1 }, doctor: async () => { mutations += 1 } }
  for (const args of [['install', '--release'], ['update', '--release'], ['doctor', '--release', 'v1'], ['unknown']]) {
    await assert.rejects(runCli(args, dependencies), /usage|release|unknown/i)
  }
  assert.equal(mutations, 0)
})

test('publication is invoked only by an explicit --pr and receives the bounded operation', async () => {
  const calls = []
  const operationResult = { status: 'updated', release: 'v1.2.4', revision: 'b'.repeat(40), changedPaths: ['.agents/zukan/release-lock.json'] }
  const dependencies = {
    cwd: () => '/consumer',
    update: async () => { calls.push('update'); return operationResult },
    publish: async ({ operation }) => {
      calls.push('publish')
      const result = await operation()
      assert.deepEqual(result, operationResult)
      return { ...result, pullRequest: 'https://github.com/ZukanTechnologies/consumer/pull/7' }
    },
    checkForUpdate: async () => ({ status: 'current' }),
  }

  assert.match(await runCli(['update', '--release', 'v1.2.4'], dependencies), /Updated/)
  assert.deepEqual(calls, ['update'])
  calls.length = 0
  assert.match(await runCli(['update', '--release', 'v1.2.4', '--pr'], dependencies), /pull\/7/)
  assert.deepEqual(calls, ['publish', 'update'])
})

test('an older healthy pin receives an actionable non-failing update notice', async () => {
  const message = await runCli(['doctor'], {
    cwd: () => '/consumer',
    doctor: async () => ({ status: 'healthy', release: 'v1.2.3', revision: 'a'.repeat(40) }),
    checkForUpdate: async () => ({ status: 'available', installedRelease: 'v1.2.3', availableRelease: 'v1.2.4' }),
  })
  assert.match(message, /healthy/i)
  assert.match(message, /v1\.2\.3.*v1\.2\.4/s)
  assert.match(message, /npx @zukantech\/agent update --release v1\.2\.4/)
})

test('default stable install resolves latest only inside the installer', async () => {
  let checks = 0
  await runCli(['install'], {
    cwd: () => '/consumer',
    install: async () => ({ status: 'installed', release: 'v1.2.4', revision: 'a'.repeat(40), changedPaths: ['.agents/zukan/release-lock.json'] }),
    checkForUpdate: async () => { checks += 1; return { status: 'current' } },
  })
  assert.equal(checks, 0)
})

test('CLI passes legacy migration only through an explicit update flag', async () => {
  const calls = []
  const dependencies = {
    cwd: () => '/consumer',
    update: async (options) => {
      calls.push(options)
      return { status: 'updated', release: 'v0.1.0-alpha.6', revision: 'd'.repeat(40), changedPaths: [] }
    },
    checkForUpdate: async () => ({ status: 'current' }),
  }
  await assert.rejects(runCli(['install', '--migrate-legacy'], dependencies), /migrate-legacy.*update/i)
  await runCli(['update', '--release', 'v0.1.0-alpha.6', '--migrate-legacy'], dependencies)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].migrateLegacy, true)
})

test('CLI binds signed repository policy only through an explicit local or PR operation', async () => {
  const calls = []
  const result = {
    status: 'bound', release: 'v0.1.0-alpha.6', revision: 'd'.repeat(40),
    changedPaths: ['.agents/zukan/release-lock.json', '.agents/zukan/repository-capabilities.json'],
  }
  const dependencies = {
    cwd: () => '/consumer',
    doctor: async () => { calls.push(['doctor']); return { status: 'healthy', release: result.release, revision: result.revision } },
    bind: async (options) => { calls.push(['bind', options.policyFile, options.attestationFile]); return result },
    publish: async ({ operation }) => { calls.push(['publish']); return { ...await operation(), pullRequest: 'https://github.com/ZukanTechnologies/zukan/pull/9' } },
  }
  assert.match(await runCli([
    'bind-policy', '--policy', '/tmp/policy.json', '--attestation', '/tmp/attestation.json',
  ], dependencies), /Bound.*v0\.1\.0-alpha\.6/i)
  assert.deepEqual(calls, [['doctor'], ['bind', '/tmp/policy.json', '/tmp/attestation.json']])
  calls.length = 0
  assert.match(await runCli([
    'bind-policy', '--policy', '/tmp/policy.json', '--attestation', '/tmp/attestation.json', '--pr',
  ], dependencies), /pull\/9/)
  assert.deepEqual(calls, [['publish'], ['doctor'], ['bind', '/tmp/policy.json', '/tmp/attestation.json']])
})

test('CLI verifies the installed release before resolving one harness admission route', async () => {
  const calls = []
  const result = await runCli([
    'admit', '--route', 'production-incident', '--harness', 'codex',
    '--target', 'sentry.telemetry=sentry:organization/zukan-tech/zukan-worker',
    '--target', 'operations.logs=railway:project/zukan/service/worker',
  ], {
    cwd: () => '/consumer',
    doctor: async () => { calls.push('doctor'); return { status: 'healthy', release: 'v0.1.0-alpha.6', revision: 'd'.repeat(40) } },
    admit: async (options) => {
      calls.push(['admit', options.route, options.harness, options.targets])
      return { output: '{"status":"requires-readback"}', exitCode: 0 }
    },
  })
  assert.deepEqual(result, { output: '{"status":"requires-readback"}', exitCode: 0 })
  assert.deepEqual(calls, ['doctor', ['admit', 'production-incident', 'codex', [
    'sentry.telemetry=sentry:organization/zukan-tech/zukan-worker',
    'operations.logs=railway:project/zukan/service/worker',
  ]]])
})

test('CLI requires a supported harness and rejects duplicate target capability selections', async () => {
  const dependencies = { doctor: async () => { throw new Error('must not run') } }
  await assert.rejects(runCli(['admit', '--route', 'bug'], dependencies), /harness/i)
  await assert.rejects(runCli(['admit', '--route', 'bug', '--harness', 'other'], dependencies), /harness/i)
  await assert.rejects(runCli([
    'admit', '--route', 'bug', '--harness', 'codex',
    '--target', 'sentry.telemetry=sentry:organization/zukan-tech/zukan-api',
    '--target', 'sentry.telemetry=sentry:organization/zukan-tech/zukan-web',
  ], dependencies), /duplicate.*target/i)
})

test('CLI preserves schema-1 observation dispatch for valid older release pins', async () => {
  const calls = []
  const result = await runCli([
    'admit', '--route', 'small-feature', '--observations', '/tmp/v1.json',
  ], {
    cwd: () => '/consumer',
    doctor: async () => ({ status: 'healthy', release: 'v1.2.0', revision: 'd'.repeat(40) }),
    admit: async (options) => { calls.push(options); return { output: '{"status":"ready"}', exitCode: 0 } },
  })
  assert.equal(result.exitCode, 0)
  assert.equal(calls[0].observationsFile, '/tmp/v1.json')
  assert.equal(calls[0].harness, undefined)
  await assert.rejects(runCli([
    'admit', '--route', 'bug', '--observations', '/tmp/v1.json', '--harness', 'codex',
  ]), /mutually exclusive/i)
})
