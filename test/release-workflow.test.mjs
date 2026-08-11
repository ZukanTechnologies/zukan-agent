import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { publishRelease } from '../scripts/release-contract.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))

function runnerFixture({ head = 'a'.repeat(40), main = true } = {}) {
  const calls = []
  const runner = async (command, args) => {
    calls.push([command, ...args])
    if (command === 'git' && args[0] === 'rev-parse') return `${head}\n`
    if (command === 'git' && args[0] === 'merge-base' && !main) throw new Error('not on main')
    return ''
  }
  return { calls, runner }
}

test('release publishing derives the non-stable tag only after proving the exact main revision', async () => {
  const fixture = runnerFixture()
  const result = await publishRelease({
    root,
    refName: 'v0.1.0-alpha.3',
    revision: 'a'.repeat(40),
    packageDocument: { name: '@zukantech/agent', version: '0.1.0-alpha.3' },
    runner: fixture.runner,
  })
  assert.equal(result.distTag, 'next')
  assert.deepEqual(fixture.calls.at(-1), [
    'npm', 'publish', '--ignore-scripts', '--access', 'public', '--tag', 'next',
    '--registry', 'https://registry.npmjs.org',
  ])
  assert.equal(fixture.calls.some((call) => call[0] === 'git' && call[1] === 'merge-base'), true)
})

test('stable releases use latest and invalid tags or non-main revisions never reach npm', async () => {
  const stable = runnerFixture()
  assert.equal((await publishRelease({
    root, refName: 'v1.0.0', revision: 'a'.repeat(40),
    packageDocument: { name: '@zukantech/agent', version: '1.0.0' }, runner: stable.runner,
  })).distTag, 'latest')

  for (const options of [
    { refName: 'v1.0.1', revision: 'a'.repeat(40), fixture: runnerFixture() },
    { refName: 'v1.0.0', revision: 'b'.repeat(40), fixture: runnerFixture() },
    { refName: 'v1.0.0', revision: 'a'.repeat(40), fixture: runnerFixture({ main: false }) },
  ]) {
    await assert.rejects(publishRelease({
      root, refName: options.refName, revision: options.revision,
      packageDocument: { name: '@zukantech/agent', version: '1.0.0' }, runner: options.fixture.runner,
    }), /tag|revision|main/i)
    assert.equal(options.fixture.calls.some((call) => call[0] === 'npm'), false)
  }
})

test('npm release workflow is tokenless, OIDC-scoped, validated, and action-SHA-pinned', async () => {
  const workflow = await readFile(path.join(root, '.github/workflows/publish.yml'), 'utf8')
  assert.match(workflow, /release:\s*\n\s*types:\s*\[published\]/)
  assert.match(workflow, /id-token:\s*write/)
  assert.match(workflow, /contents:\s*read/)
  assert.match(workflow, /environment:\s*npm/)
  assert.match(workflow, /fetch-depth:\s*0/)
  assert.match(workflow, /persist-credentials:\s*false/)
  assert.match(workflow, /npm ci[\s\S]*npm test[\s\S]*npm run validate[\s\S]*node scripts\/publish-release\.mjs/)
  assert.doesNotMatch(workflow, /NPM_TOKEN|NODE_AUTH_TOKEN|secrets\./)

  for (const relative of ['.github/workflows/ci.yml', '.github/workflows/publish.yml']) {
    const source = await readFile(path.join(root, relative), 'utf8')
    for (const line of source.split('\n').filter((entry) => entry.trim().startsWith('- uses:'))) {
      assert.match(line, /@[a-f0-9]{40}(?:\s+#.*)?$/u, `${relative} contains an unpinned action: ${line}`)
    }
  }
})
