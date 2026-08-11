import assert from 'node:assert/strict'
import { test } from 'node:test'
import { publishChange } from '../src/publish.mjs'

function runnerFixture({ dirty = false, actual = ['.agents/zukan/release-lock.json'], ignored = [], branch = 'main', defaultBranch = 'main', remoteRevision = 'a'.repeat(40) } = {}) {
  const calls = []
  const staged = [...new Set([...actual, ...ignored])]
  const runner = async (command, args) => {
    calls.push([command, ...args])
    if (command === 'git' && args[0] === 'status') return Buffer.from(dirty ? ' M application.js\0' : '')
    if (command === 'git' && args[0] === 'symbolic-ref') return Buffer.from(`${branch}\n`)
    if (command === 'gh' && args[0] === 'repo') return Buffer.from(`${defaultBranch}\n`)
    if (command === 'git' && args[0] === 'rev-parse' && args[1] === 'HEAD') return Buffer.from(`${'a'.repeat(40)}\n`)
    if (command === 'git' && args[0] === 'rev-parse') return Buffer.from(`${remoteRevision}\n`)
    if (command === 'git' && args[0] === 'diff-tree') return Buffer.from(`${staged.join('\0')}\0`)
    if (command === 'git' && args[0] === 'diff' && args.includes('--cached')) return Buffer.from(`${staged.join('\0')}\0`)
    if (command === 'git' && args[0] === 'diff') return Buffer.from(`${actual.join('\0')}\0`)
    if (command === 'git' && args[0] === 'ls-files' && args.includes('--ignored')) return Buffer.from(`${ignored.join('\0')}${ignored.length ? '\0' : ''}`)
    if (command === 'git' && args[0] === 'ls-files') return Buffer.alloc(0)
    if (command === 'gh' && args[0] === 'pr') return Buffer.from('https://github.com/ZukanTechnologies/consumer/pull/9\n')
    return Buffer.alloc(0)
  }
  return { calls, runner }
}

test('--pr publishes only the exact installer-owned diff from the default branch', async () => {
  const fixture = runnerFixture()
  let operations = 0
  const result = await publishChange({
    target: '/consumer', runner: fixture.runner,
    operation: async () => {
      operations += 1
      return { status: 'updated', release: 'v1.2.4', revision: 'b'.repeat(40), changedPaths: ['.agents/zukan/release-lock.json'] }
    },
  })
  assert.equal(operations, 1)
  assert.equal(result.pullRequest, 'https://github.com/ZukanTechnologies/consumer/pull/9')
  assert.equal(fixture.calls.some((call) => call[0] === 'git' && call[1] === 'commit'), true)
  assert.equal(fixture.calls.some((call) => call[0] === 'git' && call[1] === 'push'), true)
  assert.equal(fixture.calls.some((call) => call[0] === 'gh' && call[1] === 'pr'), true)
})

test('--pr refuses dirty or non-default starting branches before mutation', async () => {
  for (const fixture of [runnerFixture({ dirty: true }), runnerFixture({ branch: 'feature/work' })]) {
    let operations = 0
    await assert.rejects(
      publishChange({ target: '/consumer', runner: fixture.runner, operation: async () => { operations += 1 } }),
      /clean|default branch/i,
    )
    assert.equal(operations, 0)
    assert.equal(fixture.calls.some((call) => ['commit', 'push'].includes(call[1])), false)
  }
})

test('--pr refuses a stale or locally divergent default branch before mutation', async () => {
  const fixture = runnerFixture({ remoteRevision: 'b'.repeat(40) })
  let operations = 0
  await assert.rejects(
    publishChange({ target: '/consumer', runner: fixture.runner, operation: async () => { operations += 1 } }),
    /exactly match origin\/main/i,
  )
  assert.equal(operations, 0)
  assert.equal(fixture.calls.some((call) => call[1] === 'push'), false)
})

test('--pr stops before staging when the operation produces an out-of-scope path', async () => {
  const fixture = runnerFixture({ actual: ['.agents/zukan/release-lock.json', 'application.js'] })
  await assert.rejects(
    publishChange({
      target: '/consumer', runner: fixture.runner,
      operation: async () => ({ status: 'updated', release: 'v1.2.4', revision: 'b'.repeat(40), changedPaths: ['.agents/zukan/release-lock.json'] }),
    }),
    /outside.*bounded|application\.js/i,
  )
  assert.equal(fixture.calls.some((call) => call[1] === 'add'), false)
  assert.equal(fixture.calls.some((call) => call[1] === 'push'), false)
})

test('--pr force-adds an installer-owned payload hidden by consumer ignore rules', async () => {
  const actual = ['.agents/zukan/release-lock.json', '.agents/zukan/vendor/v1.2.4/skills/zukan-flow/SKILL.md']
  const fixture = runnerFixture({ actual, ignored: [actual[1]] })
  await publishChange({
    target: '/consumer', runner: fixture.runner,
    operation: async () => ({
      status: 'updated', release: 'v1.2.4', revision: 'b'.repeat(40),
      changedPaths: ['.agents/zukan/release-lock.json', '.agents/zukan/vendor/v1.2.4'],
    }),
  })
  const add = fixture.calls.find((call) => call[0] === 'git' && call[1] === 'add')
  assert.deepEqual(add.slice(0, 4), ['git', 'add', '-f', '-A'])
})
