import {
  PRIVATE_REPOSITORY,
  RELEASE_ASSETS,
  expectedProducer,
  parseJson,
  sha256,
  validateCertification,
  validateManifest,
  validateReleaseName,
} from './contracts.mjs'
import { extractVerifiedArchive } from './archive.mjs'

export function releaseLock({ manifest, manifestBytes, bundleBytes, certificationBytes }) {
  return {
    schemaVersion: manifest.schemaVersion,
    kind: 'zukan-agent-release-lock',
    repository: PRIVATE_REPOSITORY,
    release: manifest.release,
    revision: manifest.revision,
    archiveSha256: manifest.archive.sha256,
    manifestSha256: sha256(manifestBytes),
    signatureBundleSha256: sha256(bundleBytes),
    ...(certificationBytes ? { certificationSha256: sha256(certificationBytes) } : {}),
    producer: manifest.producer,
    files: manifest.files,
  }
}

export async function resolveVerifiedRelease({ requestedRelease, github, verifySigstore }) {
  if (!github || typeof verifySigstore !== 'function') throw new Error('release verification dependencies are unavailable')
  await github.authorize(PRIVATE_REPOSITORY)
  const release = await github.resolveRelease(requestedRelease ? validateReleaseName(requestedRelease) : undefined)
  const selectedRelease = validateReleaseName(release.tagName)
  if (release.draft || (!requestedRelease && release.prerelease)) {
    throw new Error('the resolved release is not an approved stable release')
  }
  const manifestBytes = await github.downloadAsset(release, RELEASE_ASSETS.manifest)
  const bundleBytes = await github.downloadAsset(release, RELEASE_ASSETS.bundle)
  const archive = await github.downloadAsset(release, RELEASE_ASSETS.archive)
  const manifest = validateManifest(parseJson(manifestBytes, 'release manifest'), selectedRelease)
  const certificationBytes = manifest.schemaVersion === 2
    ? await github.downloadAsset(release, RELEASE_ASSETS.certification)
    : null
  const resolvedRevision = await github.resolveTag(PRIVATE_REPOSITORY, selectedRelease)
  if (manifest.revision !== resolvedRevision) throw new Error('release tag revision does not match the manifest revision')
  const bundle = parseJson(bundleBytes, 'Sigstore bundle')
  const producer = expectedProducer(selectedRelease)
  await verifySigstore({
    bundle,
    artifact: manifestBytes,
    certificateIssuer: producer.issuer,
    certificateIdentityURI: producer.identity,
  })
  if (certificationBytes) {
    if (sha256(certificationBytes) !== manifest.certification.sha256) {
      throw new Error('release certification digest does not match the signed manifest')
    }
    validateCertification(parseJson(certificationBytes, 'release certification'), manifest)
  }
  const extracted = await extractVerifiedArchive(archive, manifest)
  const lock = releaseLock({ manifest, manifestBytes, bundleBytes, certificationBytes })
  return {
    manifest,
    manifestBytes,
    bundleBytes,
    certificationBytes,
    lock,
    lockBytes: Buffer.from(`${JSON.stringify(lock, null, 2)}\n`),
    extracted,
  }
}
