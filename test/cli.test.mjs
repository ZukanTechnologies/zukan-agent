import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runCli } from '../src/cli.mjs'

test('CLI routes install with an optional exact release and doctor to the current repository', async () => {
  const calls = []
  const dependencies = {
    cwd: () => '/consumer',
    install: async (options) => { calls.push(['install', options.target, options.requestedRelease]); return { status: 'installed', release: 'v1.2.3', revision: 'a'.repeat(40) } },
    doctor: async (options) => { calls.push(['doctor', options.target]); return { status: 'healthy', release: 'v1.2.3', revision: 'a'.repeat(40) } },
  }
  assert.match(await runCli(['install', '--release', 'v1.2.3'], dependencies), /Installed v1.2.3/)
  assert.match(await runCli(['doctor'], dependencies), /healthy.*v1.2.3/i)
  assert.deepEqual(calls, [['install', '/consumer', 'v1.2.3'], ['doctor', '/consumer']])
})

test('CLI rejects unknown flags, missing pins, and update-only --pr without mutation', async () => {
  let mutations = 0
  const dependencies = { install: async () => { mutations += 1 }, doctor: async () => { mutations += 1 } }
  for (const args of [['install', '--release'], ['install', '--pr'], ['doctor', '--release', 'v1'], ['unknown']]) {
    await assert.rejects(runCli(args, dependencies), /usage|release|update|unknown/i)
  }
  assert.equal(mutations, 0)
})
