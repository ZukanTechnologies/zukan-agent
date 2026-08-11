import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { checkForUpdate } from '../src/updates.mjs'

test('successful stable-release checks are cached for 24 hours per installed pin', async (t) => {
  const cacheRoot = await mkdtemp(path.join(tmpdir(), 'zukan-agent-cache-'))
  t.after(() => rm(cacheRoot, { force: true, recursive: true }))
  let requests = 0
  const github = {
    async resolveRelease() {
      requests += 1
      return { tagName: 'v1.2.4', draft: false, prerelease: false }
    },
  }
  const first = await checkForUpdate({ target: '/consumer', installedRelease: 'v1.2.3', github, cacheRoot, now: () => 1_000_000 })
  const cached = await checkForUpdate({ target: '/consumer', installedRelease: 'v1.2.3', github, cacheRoot, now: () => 1_000_000 + 23 * 60 * 60 * 1000 })
  assert.deepEqual(first, { status: 'available', installedRelease: 'v1.2.3', availableRelease: 'v1.2.4', cached: false })
  assert.deepEqual(cached, { ...first, cached: true })
  assert.equal(requests, 1)
})

test('stale or unavailable update metadata never makes a valid pin fail', async (t) => {
  const cacheRoot = await mkdtemp(path.join(tmpdir(), 'zukan-agent-cache-'))
  t.after(() => rm(cacheRoot, { force: true, recursive: true }))
  const result = await checkForUpdate({
    target: '/consumer',
    installedRelease: 'v1.2.3',
    cacheRoot,
    now: () => 2_000_000,
    github: { resolveRelease: async () => { throw new Error('offline') } },
  })
  assert.deepEqual(result, { status: 'unavailable' })
})

test('a current pin does not receive an update warning', async (t) => {
  const cacheRoot = await mkdtemp(path.join(tmpdir(), 'zukan-agent-cache-'))
  t.after(() => rm(cacheRoot, { force: true, recursive: true }))
  const result = await checkForUpdate({
    target: '/consumer', installedRelease: 'v1.2.4', cacheRoot,
    github: { resolveRelease: async () => ({ tagName: 'v1.2.4', draft: false, prerelease: false }) },
  })
  assert.equal(result.status, 'current')
})

test('a fresh update remains advisory when the local cache cannot be written', async (t) => {
  const cacheRoot = await mkdtemp(path.join(tmpdir(), 'zukan-agent-cache-file-'))
  t.after(() => rm(cacheRoot, { force: true, recursive: true }))
  const blockedCache = path.join(cacheRoot, 'not-a-directory')
  await writeFile(blockedCache, 'blocked\n')
  const result = await checkForUpdate({
    target: '/consumer', installedRelease: 'v1.2.3', cacheRoot: blockedCache,
    github: { resolveRelease: async () => ({ tagName: 'v1.2.4', draft: false, prerelease: false }) },
  })
  assert.equal(result.status, 'available')
  assert.equal(result.availableRelease, 'v1.2.4')
})
