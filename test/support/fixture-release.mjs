import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import * as tar from 'tar'
import { PRIVATE_REPOSITORY, RELEASE_ASSETS, expectedProducer, sha256 } from '../../src/contracts.mjs'

const defaults = {
  'skills/zukan-flow/SKILL.md': '---\nname: zukan-flow\ndescription: fixture\n---\n',
  'workflow/catalog.json': '{"schemaVersion":1}\n',
  'bin/evaluate-route-admission.mjs': 'export {}\n',
}
const certificationAsset = 'zukan-agent-certification.json'

export async function createFixtureRelease(t, options = {}) {
  const fixture = await mkdtemp(path.join(tmpdir(), 'zukan-agent-source-'))
  t.after(() => rm(fixture, { force: true, recursive: true }))
  const release = options.release ?? 'v1.1.0-rc.1'
  const revision = options.revision ?? 'a'.repeat(40)
  const fault = options.fault ?? {}
  const certified = options.certified ?? false
  const certificationContract = '{"schemaVersion":1,"kind":"zukan-harness-certification"}\n'
  const files = {
    ...(options.files ?? defaults),
    ...(certified ? { 'workflow/v1-certification-contract.json': certificationContract } : {}),
  }
  const payload = path.join(fixture, 'payload')
  await mkdir(payload)
  const inventory = []
  for (const [relative, contents] of Object.entries(files)) {
    const file = path.join(payload, relative)
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, contents)
    inventory.push({ path: relative, sha256: sha256(Buffer.from(contents)) })
  }
  if (fault.extractedFileMutation) {
    const first = inventory[0].path
    await writeFile(path.join(payload, first), `${files[first]}mutated\n`)
  }
  const archivePath = path.join(fixture, RELEASE_ASSETS.archive)
  await tar.c({ cwd: payload, file: archivePath, gzip: true, portable: true }, ['.'])
  const archive = await readFile(archivePath)
  const certification = certified ? {
    schemaVersion: 1,
    kind: 'zukan-agent-certification',
    repository: PRIVATE_REPOSITORY,
    release,
    revision,
    contract: {
      path: 'workflow/v1-certification-contract.json',
      sha256: fault.certificationContractDigest ?? sha256(Buffer.from(certificationContract)),
    },
    harnesses: [
      { name: 'claude-code', package: '@anthropic-ai/claude-code', binary: 'claude', version: '2.1.220', result: 'passed' },
      { name: 'codex', package: '@openai/codex', binary: 'codex', version: '0.146.0', result: 'passed' },
      { name: 'opencode', package: 'opencode-ai', binary: 'opencode', version: '1.18.11', result: 'passed' },
    ],
    gates: [
      { name: 'native-marketplace-installation', result: 'passed' },
      { name: 'repository-discovery', result: 'passed' },
      { name: 'capability-admission', result: 'passed' },
      { name: 'content-identity', result: 'passed' },
      { name: 'integrity', result: 'passed' },
    ],
    nativeMarketplace: {
      marketplace: 'zukan-technologies',
      plugin: 'zukan-sdlc',
      version: release.split('-')[0].slice(1),
      skills: 10,
      claude: 'installed',
      codex: 'installed',
      opencode: 'discovered',
      repository: 'vendored',
    },
  } : null
  const certificationBytes = certified ? Buffer.from(`${JSON.stringify(certification, null, 2)}\n`) : null
  const minimumBootstrapVersion = options.minimumBootstrapVersion
  const manifest = {
    schemaVersion: certified ? (minimumBootstrapVersion ? 3 : 2) : 1,
    kind: 'zukan-agent-release',
    repository: PRIVATE_REPOSITORY,
    release,
    revision: fault.manifestRevision ?? revision,
    producer: fault.producerIdentity
      ? { ...expectedProducer(release), identity: fault.producerIdentity }
      : expectedProducer(release),
    archive: { name: RELEASE_ASSETS.archive, sha256: sha256(archive) },
    ...(certified ? { certification: { name: certificationAsset, sha256: sha256(certificationBytes) } } : {}),
    ...(minimumBootstrapVersion ? { minimumBootstrapVersion } : {}),
    files: inventory.sort((left, right) => left.path.localeCompare(right.path)),
  }
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`)
  const bundleBytes = Buffer.from('{"fixture":"sigstore-bundle"}\n')
  const assets = new Map([
    [RELEASE_ASSETS.manifest, manifestBytes],
    [RELEASE_ASSETS.bundle, bundleBytes],
    [RELEASE_ASSETS.archive, fault.archiveBytes ?? archive],
    ...(certified ? [[certificationAsset, fault.certificationBytes ?? certificationBytes]] : []),
  ])
  return {
    release,
    revision,
    files,
    archive,
    certificationBytes,
    manifestBytes,
    github({ events = [], authorized = true } = {}) {
      return {
        async authorize() {
          events.push('authorize')
          if (!authorized) throw new Error('GitHub identity is not authorized for protected repository access')
        },
        async resolveRelease() {
          events.push('resolve-release')
          return { tagName: release, draft: false, prerelease: options.prerelease ?? true }
        },
        async downloadAsset(_release, name) {
          events.push(`download-${name === RELEASE_ASSETS.manifest ? 'manifest' : name === RELEASE_ASSETS.bundle ? 'bundle' : name === certificationAsset ? 'certification' : 'archive'}`)
          return assets.get(name)
        },
        async resolveTag() {
          events.push('resolve-tag')
          return fault.resolvedTag ?? revision
        },
      }
    },
    verifier({ events = [] } = {}) {
      return async ({ bundle, artifact, certificateIssuer, certificateIdentityURI }) => {
        events.push('verify-signature')
        if (fault.signatureValid === false) throw new Error('release signature verification failed')
        const expected = expectedProducer(release)
        if (certificateIssuer !== expected.issuer || certificateIdentityURI !== expected.identity) {
          throw new Error('release producer identity verification failed')
        }
        if (!Buffer.from(artifact).equals(manifestBytes) || JSON.stringify(bundle) !== JSON.stringify(JSON.parse(bundleBytes))) {
          throw new Error('release signature verification failed')
        }
      }
    },
  }
}
