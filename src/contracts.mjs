import { createHash } from 'node:crypto'

export const PRIVATE_REPOSITORY = 'ZukanTechnologies/agent-skills'
export const RELEASE_ASSETS = Object.freeze({
  manifest: 'zukan-agent-release.json',
  certification: 'zukan-agent-certification.json',
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
  const manifestFields = ['schemaVersion', 'kind', 'repository', 'release', 'revision', 'producer', 'archive', 'files']
  if (value?.schemaVersion === 2) manifestFields.push('certification')
  exactKeys(value, manifestFields, 'release manifest')
  if (![1, 2].includes(value.schemaVersion) || value.kind !== 'zukan-agent-release' || value.repository !== PRIVATE_REPOSITORY) {
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
  if (value.schemaVersion === 2) {
    exactKeys(value.certification, ['name', 'sha256'], 'release certification')
    if (
      value.certification.name !== RELEASE_ASSETS.certification
      || !/^[a-f0-9]{64}$/.test(value.certification.sha256 ?? '')
    ) {
      throw new Error('release certification identity is invalid')
    }
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

export function validateCertification(value, manifest) {
  exactKeys(value, [
    'schemaVersion', 'kind', 'repository', 'release', 'revision', 'contract',
    'harnesses', 'gates', 'nativeMarketplace',
  ], 'release certification receipt')
  if (
    value.schemaVersion !== 1
    || value.kind !== 'zukan-agent-certification'
    || value.repository !== PRIVATE_REPOSITORY
    || value.release !== manifest.release
    || value.revision !== manifest.revision
  ) {
    throw new Error('release certification receipt identity is invalid')
  }
  exactKeys(value.contract, ['path', 'sha256'], 'release certification contract')
  if (
    value.contract.path !== 'workflow/v1-certification-contract.json'
    || !/^[a-f0-9]{64}$/.test(value.contract.sha256 ?? '')
  ) {
    throw new Error('release certification contract identity is invalid')
  }
  const expectedHarnesses = [
    ['claude-code', '@anthropic-ai/claude-code', 'claude'],
    ['codex', '@openai/codex', 'codex'],
    ['opencode', 'opencode-ai', 'opencode'],
  ]
  if (!Array.isArray(value.harnesses) || value.harnesses.length !== expectedHarnesses.length) {
    throw new Error('release certification harness results are invalid')
  }
  for (const [index, harness] of value.harnesses.entries()) {
    exactKeys(harness, ['name', 'package', 'binary', 'version', 'result'], 'release certification harness')
    const [name, packageName, binary] = expectedHarnesses[index]
    if (
      harness.name !== name
      || harness.package !== packageName
      || harness.binary !== binary
      || typeof harness.version !== 'string'
      || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(harness.version)
      || harness.result !== 'passed'
    ) {
      throw new Error('release certification harness results are invalid')
    }
  }
  const expectedGates = [
    'native-marketplace-installation',
    'repository-discovery',
    'capability-admission',
    'content-identity',
    'integrity',
  ]
  if (!Array.isArray(value.gates) || value.gates.length !== expectedGates.length) {
    throw new Error('release certification gate results are invalid')
  }
  for (const [index, gate] of value.gates.entries()) {
    exactKeys(gate, ['name', 'result'], 'release certification gate')
    if (gate.name !== expectedGates[index] || gate.result !== 'passed') {
      throw new Error('release certification gate results are invalid')
    }
  }
  const contractFile = manifest.files.find(({ path: relative }) => relative === value.contract.path)
  if (!contractFile || contractFile.sha256 !== value.contract.sha256) {
    throw new Error('release certification contract digest does not match the signed inventory')
  }
  exactKeys(value.nativeMarketplace, [
    'marketplace', 'plugin', 'version', 'skills', 'claude', 'codex', 'opencode', 'repository',
  ], 'native marketplace certification')
  if (
    value.nativeMarketplace.marketplace !== 'zukan-technologies'
    || value.nativeMarketplace.plugin !== 'zukan-sdlc'
    || value.nativeMarketplace.version !== manifest.release.split('-')[0].slice(1)
    || !Number.isSafeInteger(value.nativeMarketplace.skills)
    || value.nativeMarketplace.skills <= 0
    || value.nativeMarketplace.claude !== 'installed'
    || value.nativeMarketplace.codex !== 'installed'
    || value.nativeMarketplace.opencode !== 'discovered'
    || value.nativeMarketplace.repository !== 'vendored'
  ) {
    throw new Error('native marketplace certification result is invalid')
  }
  return value
}

export function pathIsUnsafe(relative) {
  return relative.includes('\\')
    || relative.startsWith('/')
    || relative.split('/').some((part) => !part || part === '.' || part === '..')
}
