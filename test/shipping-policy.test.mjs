import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repository = path.resolve(fileURLToPath(new URL('..', import.meta.url)))

test('repository commits the canonical Zukan shipping policy', async () => {
  const policy = JSON.parse(await readFile(path.join(repository, 'workflow/shipping-policy.json'), 'utf8'))

  assert.equal(policy.kind, 'zukan-shipping-policy')
  assert.equal(policy.policy.pullRequestBase, 'main')
  assert.equal(policy.policy.publishAsDraft, true)
  assert.equal(policy.policy.mergeMethod, 'squash')
  assert.deepEqual(policy.policy.requiredChecks, ['validate'])
  assert.equal(policy.policy.stagingRequired, false)
})
