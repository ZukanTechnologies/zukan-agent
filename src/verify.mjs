import { verify } from 'sigstore'

export async function verifySigstoreRelease({ bundle, artifact, certificateIssuer, certificateIdentityURI }) {
  try {
    await verify(bundle, artifact, {
      certificateIssuer,
      certificateIdentityURI,
      ctLogThreshold: 1,
      tlogThreshold: 1,
    })
  } catch {
    throw new Error('release Sigstore signature or approved producer identity verification failed')
  }
}
