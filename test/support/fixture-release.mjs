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

export async function createFixtureRelease(t, options = {}) {
  const fixture = await mkdtemp(path.join(tmpdir(), 'zukan-agent-source-'))
  t.after(() => rm(fixture, { force: true, recursive: true }))
  const release = options.release ?? 'v1.1.0-rc.1'
  const revision = options.revision ?? 'a'.repeat(40)
  const files = options.files ?? defaults
  const fault = options.fault ?? {}
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
  const manifest = {
    schemaVersion: 1,
    kind: 'zukan-agent-release',
    repository: PRIVATE_REPOSITORY,
    release,
    revision: fault.manifestRevision ?? revision,
    producer: fault.producerIdentity
      ? { ...expectedProducer(release), identity: fault.producerIdentity }
      : expectedProducer(release),
    archive: { name: RELEASE_ASSETS.archive, sha256: sha256(archive) },
    files: inventory.sort((left, right) => left.path.localeCompare(right.path)),
  }
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`)
  const bundleBytes = Buffer.from('{"fixture":"sigstore-bundle"}\n')
  const assets = new Map([
    [RELEASE_ASSETS.manifest, manifestBytes],
    [RELEASE_ASSETS.bundle, bundleBytes],
    [RELEASE_ASSETS.archive, fault.archiveBytes ?? archive],
  ])
  return {
    release,
    revision,
    files,
    archive,
    manifestBytes,
    github({ events = [], authorized = true } = {}) {
      return {
        async authorize() {
          events.push('authorize')
          if (!authorized) throw new Error('GitHub identity is not authorized for protected repository access')
        },
        async resolveRelease() {
          events.push('resolve-release')
          return { tagName: release, draft: false, prerelease: true }
        },
        async downloadAsset(_release, name) {
          events.push(`download-${name === RELEASE_ASSETS.manifest ? 'manifest' : name === RELEASE_ASSETS.bundle ? 'bundle' : 'archive'}`)
          return assets.get(name)
        },
        async resolveTag() {
          events.push('resolve-tag')
          return fault.resolvedTag ?? revision
        },
      }
    },
    verifier({ events = [] } = {}) {
      return async ({ certificateIssuer, certificateIdentityURI }) => {
        events.push('verify-signature')
        if (fault.signatureValid === false) throw new Error('release signature verification failed')
        const expected = expectedProducer(release)
        if (certificateIssuer !== expected.issuer || certificateIdentityURI !== expected.identity) {
          throw new Error('release producer identity verification failed')
        }
      }
    },
  }
}
