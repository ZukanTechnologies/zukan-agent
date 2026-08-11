import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PRIVATE_REPOSITORY, RELEASE_ASSETS } from '../src/contracts.mjs'
import { createGitHubClient } from '../src/github.mjs'

test('GitHub authorization proves private-repository access before release discovery', async () => {
  const calls = []
  const runner = async (args) => {
    calls.push(args)
    if (args.includes(`/repos/${PRIVATE_REPOSITORY}`)) return Buffer.from(`${PRIVATE_REPOSITORY}\n`)
    throw new Error('unexpected call')
  }
  const github = createGitHubClient({ runner })

  await github.authorize(PRIVATE_REPOSITORY)
  assert.deepEqual(calls, [['api', `/repos/${PRIVATE_REPOSITORY}`, '--jq', '.full_name']])
})

test('authorization errors are actionable and never echo CLI output or credentials', async () => {
  const github = createGitHubClient({
    runner: async () => {
      const error = new Error('gh failed: ghp_secret_from_stderr')
      error.stderr = 'ghp_secret_from_stderr'
      throw error
    },
  })
  await assert.rejects(
    github.authorize(PRIVATE_REPOSITORY),
    (error) => /gh auth login/.test(error.message) && !error.message.includes('ghp_'),
  )
})

test('release resolution, exact asset download, and annotated-tag peeling use GitHub APIs', async () => {
  const calls = []
  const bundleAssetId = Object.values(RELEASE_ASSETS).indexOf(RELEASE_ASSETS.bundle) + 1
  const runner = async (args) => {
    calls.push(args)
    const endpoint = args.find((argument) => argument.startsWith('/repos/'))
    if (endpoint.endsWith('/releases/tags/v1.2.3')) {
      return Buffer.from(JSON.stringify({
        tag_name: 'v1.2.3', draft: false, prerelease: false,
        assets: Object.values(RELEASE_ASSETS).map((name, index) => ({ id: index + 1, name })),
      }))
    }
    if (endpoint.endsWith(`/releases/assets/${bundleAssetId}`)) return Buffer.from('bundle bytes')
    if (endpoint.endsWith('/git/ref/tags/v1.2.3')) return Buffer.from(JSON.stringify({ object: { type: 'tag', sha: 'a'.repeat(40) } }))
    if (endpoint.endsWith(`/git/tags/${'a'.repeat(40)}`)) return Buffer.from(JSON.stringify({ object: { type: 'commit', sha: 'b'.repeat(40) } }))
    throw new Error(`unexpected ${endpoint}`)
  }
  const github = createGitHubClient({ runner })
  const release = await github.resolveRelease('v1.2.3')
  assert.equal(release.tagName, 'v1.2.3')
  assert.equal((await github.downloadAsset(release, RELEASE_ASSETS.bundle)).toString(), 'bundle bytes')
  assert.equal(await github.resolveTag(PRIVATE_REPOSITORY, 'v1.2.3'), 'b'.repeat(40))
  assert.equal(calls.some((args) => args.includes('-H') && args.includes('Accept: application/octet-stream')), true)
})

test('missing or duplicate named release assets are rejected', async () => {
  const release = { assets: [{ id: 1, name: RELEASE_ASSETS.manifest }, { id: 2, name: RELEASE_ASSETS.manifest }] }
  const github = createGitHubClient({ runner: async () => Buffer.alloc(0) })
  await assert.rejects(github.downloadAsset(release, RELEASE_ASSETS.manifest), /exactly one/)
  await assert.rejects(github.downloadAsset({ assets: [] }, RELEASE_ASSETS.archive), /exactly one/)
})
