import { createHash } from 'node:crypto'

export const PRIVATE_REPOSITORY = 'ZukanTechnologies/agent-skills'
export const RELEASE_ASSETS = Object.freeze({
  manifest: 'zukan-agent-release.json',
  bundle: 'zukan-agent-release.sigstore.json',
  archive: 'zukan-agent-release.tar.gz',
})
export const GITHUB_ACTIONS_ISSUER = 'https://token.actions.githubusercontent.com'
export const RELEASE_WORKFLOW = 'release.yml'

export const sha256 = (value) => createHash('sha256').update(value).digest('hex')

export function exactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
  const actual = Object.keys(value).sort()
  if (JSON.stringify(actual) !== JSON.stringify([...expected].sort())) {
    throw new Error(`${label} fields are invalid`)
  }
}

function rejectDuplicateKeys(source, label) {
  let index = 0
  const whitespace = () => { while (/\s/u.test(source[index] ?? '')) index += 1 }
  const string = () => {
    const start = index++
    while (index < source.length) {
      if (source[index] === '\\') index += 2
      else if (source[index++] === '"') return JSON.parse(source.slice(start, index))
    }
    throw new Error(`${label} must contain valid JSON`)
  }
  const value = () => {
    whitespace()
    if (index >= source.length) throw new Error(`${label} must contain valid JSON`)
    if (source[index] === '{') {
      index += 1
      whitespace()
      const seen = new Set()
      while (source[index] !== '}') {
        if (index >= source.length || source[index] !== '"') throw new Error(`${label} must contain valid JSON`)
        const key = string()
        if (seen.has(key)) throw new Error(`${label} contains a duplicate object key`)
        seen.add(key)
        whitespace()
        if (source[index++] !== ':') throw new Error(`${label} must contain valid JSON`)
        value()
        whitespace()
        if (source[index] === ',') { index += 1; whitespace() }
        else if (source[index] !== '}') throw new Error(`${label} must contain valid JSON`)
      }
      index += 1
    } else if (source[index] === '[') {
      index += 1
      whitespace()
      while (source[index] !== ']') {
        if (index >= source.length) throw new Error(`${label} must contain valid JSON`)
        value()
        whitespace()
        if (source[index] === ',') { index += 1; whitespace() }
        else if (source[index] !== ']') throw new Error(`${label} must contain valid JSON`)
      }
      index += 1
    } else if (source[index] === '"') string()
    else {
      const start = index
      while (index < source.length && !/[\s,\]}]/u.test(source[index])) index += 1
      if (start === index) throw new Error(`${label} must contain valid JSON`)
    }
  }
  value()
  whitespace()
  if (index !== source.length) throw new Error(`${label} must contain valid JSON`)
}

export function parseJson(bytes, label) {
  const source = Buffer.isBuffer(bytes) ? bytes.toString('utf8') : bytes
  try {
    rejectDuplicateKeys(source, label)
    return JSON.parse(source)
  } catch (error) {
    if (error.message.includes('duplicate object key')) throw error
    throw new Error(`${label} must contain valid JSON`)
  }
}

export function validateReleaseName(value, label = 'release') {
  if (typeof value !== 'string' || !/^v[0-9A-Za-z][0-9A-Za-z._-]{0,63}$/.test(value)) {
    throw new Error(`${label} is invalid`)
  }
  return value
}

export function expectedProducer(release) {
  return {
    issuer: GITHUB_ACTIONS_ISSUER,
    identity: `https://github.com/${PRIVATE_REPOSITORY}/.github/workflows/${RELEASE_WORKFLOW}@refs/tags/${release}`,
  }
}

export function validateManifest(value, selectedRelease) {
  exactKeys(value, ['schemaVersion', 'kind', 'repository', 'release', 'revision', 'producer', 'archive', 'files'], 'release manifest')
  if (value.schemaVersion !== 1 || value.kind !== 'zukan-agent-release' || value.repository !== PRIVATE_REPOSITORY) {
    throw new Error('release manifest producer repository is invalid')
  }
  validateReleaseName(value.release, 'manifest release')
  if (value.release !== selectedRelease) throw new Error('release manifest tag does not match the selected release')
  if (typeof value.revision !== 'string' || !/^[a-f0-9]{40}$/.test(value.revision)) {
    throw new Error('release manifest revision is invalid')
  }
  exactKeys(value.producer, ['issuer', 'identity'], 'release producer')
  const producer = expectedProducer(value.release)
  if (value.producer.issuer !== producer.issuer || value.producer.identity !== producer.identity) {
    throw new Error('release producer identity is not approved')
  }
  exactKeys(value.archive, ['name', 'sha256'], 'release archive')
  if (value.archive.name !== RELEASE_ASSETS.archive || !/^[a-f0-9]{64}$/.test(value.archive.sha256 ?? '')) {
    throw new Error('release archive identity is invalid')
  }
  if (!Array.isArray(value.files) || value.files.length === 0 || value.files.length > 2_000) {
    throw new Error('release file inventory is invalid')
  }
  const seen = new Set()
  for (const file of value.files) {
    exactKeys(file, ['path', 'sha256'], 'release file')
    if (typeof file.path !== 'string' || !file.path || pathIsUnsafe(file.path) || seen.has(file.path)) {
      throw new Error('release file path is invalid')
    }
    if (typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(file.sha256)) {
      throw new Error(`${file.path} release file digest is invalid`)
    }
    seen.add(file.path)
  }
  if (!seen.has('workflow/catalog.json')) throw new Error('release workflow catalog is missing')
  if (![...seen].some((relative) => relative.startsWith('bin/'))) {
    throw new Error('release executable payload is missing')
  }
  if (![...seen].some((relative) => /^skills\/[^/]+\/SKILL\.md$/.test(relative))) {
    throw new Error('release skill catalog is missing')
  }
  return value
}

export function pathIsUnsafe(relative) {
  return relative.includes('\\')
    || relative.startsWith('/')
    || relative.split('/').some((part) => !part || part === '.' || part === '..')
}
