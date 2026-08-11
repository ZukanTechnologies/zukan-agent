import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import * as tar from 'tar'
import { pathIsUnsafe, sha256 } from './contracts.mjs'

const MAX_ARCHIVE_BYTES = 25 * 1024 * 1024
const MAX_EXPANDED_BYTES = 50 * 1024 * 1024

function normalizedTarPath(value) {
  return value.replace(/^\.\//, '').replace(/\/$/, '')
}

function validateEntry(entry, state) {
  const relative = normalizedTarPath(entry.path)
  if (!relative) return
  if (pathIsUnsafe(relative) || !['File', 'Directory'].includes(entry.type)) {
    throw new Error(`release archive contains unsafe entry ${relative}`)
  }
  if (state.paths.has(relative)) throw new Error(`release archive contains duplicate entry ${relative}`)
  state.paths.add(relative)
  state.entries += 1
  state.bytes += Number(entry.size ?? 0)
  if (state.entries > 2_000 || state.bytes > MAX_EXPANDED_BYTES) {
    throw new Error('release archive exceeds safe extraction limits')
  }
}

export async function extractVerifiedArchive(archive, manifest) {
  if (!Buffer.isBuffer(archive) || archive.length === 0 || archive.length > MAX_ARCHIVE_BYTES) {
    throw new Error('release archive size is invalid')
  }
  if (sha256(archive) !== manifest.archive.sha256) throw new Error('release archive digest does not match')
  const fixture = await mkdtemp(path.join(tmpdir(), 'zukan-agent-release-'))
  const archiveFile = path.join(fixture, 'release.tar.gz')
  const extracted = path.join(fixture, 'extracted')
  await mkdir(extracted)
  await writeFile(archiveFile, archive)
  const state = { entries: 0, bytes: 0, paths: new Set() }
  let archiveError
  try {
    await tar.t({
      file: archiveFile,
      strict: true,
      onReadEntry(entry) {
        if (archiveError) return
        try { validateEntry(entry, state) } catch (error) { archiveError = error }
      },
    })
    if (archiveError) throw archiveError
    await tar.x({
      file: archiveFile,
      cwd: extracted,
      strict: true,
      preservePaths: false,
    })
    const entries = await readdir(extracted, { recursive: true, withFileTypes: true })
    const files = new Map()
    for (const entry of entries) {
      const absolute = path.join(entry.parentPath, entry.name)
      const relative = path.relative(extracted, absolute).split(path.sep).join('/')
      const metadata = await lstat(absolute)
      if (metadata.isSymbolicLink() || (!metadata.isDirectory() && !metadata.isFile())) {
        throw new Error(`release archive extracted unsafe entry ${relative}`)
      }
      if (metadata.isFile()) files.set(relative, sha256(await readFile(absolute)))
    }
    const expected = new Map(manifest.files.map((file) => [file.path, file.sha256]))
    if (files.size !== expected.size) throw new Error('release file inventory does not match')
    for (const [relative, digest] of expected) {
      if (files.get(relative) !== digest) throw new Error(`${relative} release file digest does not match`)
    }
    return {
      root: extracted,
      cleanup: () => rm(fixture, { force: true, recursive: true }),
    }
  } catch (error) {
    await rm(fixture, { force: true, recursive: true })
    throw error
  }
}
