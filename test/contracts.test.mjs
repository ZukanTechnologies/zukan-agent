import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseJson, pathIsUnsafe, requireCompatibleBootstrap, validateManifest } from '../src/contracts.mjs'
import { createFixtureRelease } from './support/fixture-release.mjs'

test('strict JSON parsing rejects duplicate keys at every nesting level', () => {
  assert.throws(
    () => parseJson('{"outer":{"release":"v1","release":"v2"}}', 'fixture'),
    /duplicate object key/,
  )
})

test('schema-3 releases bind a minimum compatible public bootstrap', async (t) => {
  const release = await createFixtureRelease(t, {
    release: 'v1.3.0', certified: true, prerelease: false, minimumBootstrapVersion: '0.2.0',
  })
  const manifest = JSON.parse(release.manifestBytes)
  assert.equal(validateManifest(manifest, release.release).minimumBootstrapVersion, '0.2.0')
  assert.equal(requireCompatibleBootstrap('0.2.0', '0.2.0'), '0.2.0')
  assert.equal(requireCompatibleBootstrap('0.2.0', '0.3.0'), '0.2.0')
  assert.throws(() => requireCompatibleBootstrap('0.2.0', '0.1.0'), /install.*0\.2\.0/i)
  assert.throws(() => validateManifest({ ...manifest, minimumBootstrapVersion: '0.2' }, release.release), /minimum bootstrap/i)
})

test('archive paths reject traversal, absolute, empty, and platform-alternate forms', () => {
  for (const candidate of ['../escape', 'skills/../escape', '/absolute', 'skills\\escape', 'skills//escape', './escape']) {
    assert.equal(pathIsUnsafe(candidate), true, candidate)
  }
})

test('a manifest must contain the workflow and executable roots installed by the bootstrap', async (t) => {
  const release = await createFixtureRelease(t)
  const manifest = JSON.parse(release.manifestBytes)
  manifest.files = manifest.files.filter((file) => file.path !== 'workflow/catalog.json')
  assert.throws(() => validateManifest(manifest, release.release), /workflow catalog/i)

  manifest.files.push({ path: 'workflow/catalog.json', sha256: 'a'.repeat(64) })
  manifest.files = manifest.files.filter((file) => !file.path.startsWith('bin/'))
  assert.throws(() => validateManifest(manifest, release.release), /executable/i)
})
