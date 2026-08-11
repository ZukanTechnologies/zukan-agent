import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { PRIVATE_REPOSITORY, RELEASE_ASSETS, parseJson, validateReleaseName } from './contracts.mjs'

const execFileAsync = promisify(execFile)
const MAX_GH_OUTPUT = 30 * 1024 * 1024

async function defaultRunner(args) {
  const { stdout } = await execFileAsync('gh', args, {
    encoding: 'buffer',
    maxBuffer: MAX_GH_OUTPUT,
    timeout: 60_000,
  })
  return stdout
}

function endpoint(repository, suffix) {
  return `/repos/${repository}${suffix}`
}

function validateReleaseResponse(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('GitHub release response is invalid')
  const tagName = validateReleaseName(value.tag_name, 'GitHub release tag')
  if (typeof value.draft !== 'boolean' || typeof value.prerelease !== 'boolean' || !Array.isArray(value.assets)) {
    throw new Error('GitHub release response is invalid')
  }
  const assets = value.assets.map((asset) => {
    if (!asset || !Number.isSafeInteger(asset.id) || asset.id <= 0 || typeof asset.name !== 'string') {
      throw new Error('GitHub release asset response is invalid')
    }
    return { id: asset.id, name: asset.name }
  })
  return { tagName, draft: value.draft, prerelease: value.prerelease, assets }
}

function validateGitObject(value, label) {
  const object = value?.object
  if (!object || !['commit', 'tag'].includes(object.type) || typeof object.sha !== 'string' || !/^[a-f0-9]{40}$/.test(object.sha)) {
    throw new Error(`${label} response is invalid`)
  }
  return object
}

export function createGitHubClient({ runner = defaultRunner } = {}) {
  const api = async (args, label) => {
    try {
      const output = await runner(['api', ...args])
      return Buffer.isBuffer(output) ? output : Buffer.from(output)
    } catch {
      throw new Error(`${label} failed; run gh auth login and confirm your GitHub identity can read ${PRIVATE_REPOSITORY}`)
    }
  }

  return {
    async authorize(repository) {
      if (repository !== PRIVATE_REPOSITORY) throw new Error('GitHub authorization repository is invalid')
      const output = await api([endpoint(repository, ''), '--jq', '.full_name'], 'GitHub authorization')
      if (output.toString('utf8').trim() !== repository) {
        throw new Error(`GitHub authorization failed; run gh auth login and confirm your GitHub identity can read ${PRIVATE_REPOSITORY}`)
      }
    },

    async resolveRelease(requestedRelease) {
      const suffix = requestedRelease
        ? `/releases/tags/${encodeURIComponent(validateReleaseName(requestedRelease))}`
        : '/releases/latest'
      const output = await api([endpoint(PRIVATE_REPOSITORY, suffix)], 'GitHub release discovery')
      return validateReleaseResponse(parseJson(output, 'GitHub release response'))
    },

    async downloadAsset(release, name) {
      if (!Object.values(RELEASE_ASSETS).includes(name)) throw new Error('release asset name is invalid')
      const matches = release?.assets?.filter((asset) => asset.name === name) ?? []
      if (matches.length !== 1) throw new Error(`release must contain exactly one ${name} asset`)
      return api([
        '-H', 'Accept: application/octet-stream',
        endpoint(PRIVATE_REPOSITORY, `/releases/assets/${matches[0].id}`),
      ], 'GitHub release asset download')
    },

    async resolveTag(repository, release) {
      if (repository !== PRIVATE_REPOSITORY) throw new Error('GitHub tag repository is invalid')
      const tag = validateReleaseName(release)
      const refBytes = await api([endpoint(repository, `/git/ref/tags/${encodeURIComponent(tag)}`)], 'GitHub tag resolution')
      let object = validateGitObject(parseJson(refBytes, 'GitHub tag response'), 'GitHub tag')
      const visited = new Set()
      for (let depth = 0; object.type === 'tag' && depth < 5; depth += 1) {
        if (visited.has(object.sha)) throw new Error('GitHub annotated tag chain contains a cycle')
        visited.add(object.sha)
        const tagBytes = await api([endpoint(repository, `/git/tags/${object.sha}`)], 'GitHub annotated tag resolution')
        object = validateGitObject(parseJson(tagBytes, 'GitHub annotated tag response'), 'GitHub annotated tag')
      }
      if (object.type !== 'commit') throw new Error('GitHub annotated tag chain is too deep')
      return object.sha
    },
  }
}
