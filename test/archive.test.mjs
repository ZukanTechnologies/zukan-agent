import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import * as tar from 'tar'
import { extractVerifiedArchive } from '../src/archive.mjs'
import { RELEASE_ASSETS, sha256 } from '../src/contracts.mjs'

test('archive extraction rejects symlinks before payload materialization', async (t) => {
  const fixture = await mkdtemp(path.join(tmpdir(), 'zukan-agent-unsafe-archive-'))
  t.after(() => rm(fixture, { force: true, recursive: true }))
  const payload = path.join(fixture, 'payload')
  await mkdir(payload)
  await writeFile(path.join(payload, 'safe.txt'), 'safe\n')
  await symlink('safe.txt', path.join(payload, 'link.txt'))
  const archivePath = path.join(fixture, RELEASE_ASSETS.archive)
  await tar.c({ cwd: payload, file: archivePath, gzip: true, portable: true }, ['.'])
  const archive = await readFile(archivePath)
  const manifest = {
    archive: { sha256: sha256(archive) },
    files: [{ path: 'safe.txt', sha256: sha256(Buffer.from('safe\n')) }],
  }
  await assert.rejects(extractVerifiedArchive(archive, manifest), /unsafe entry.*link\.txt/i)
})

test('archive extraction rejects duplicate paths rather than accepting overwrite order', async (t) => {
  const fixture = await mkdtemp(path.join(tmpdir(), 'zukan-agent-duplicate-archive-'))
  t.after(() => rm(fixture, { force: true, recursive: true }))
  await writeFile(path.join(fixture, 'safe.txt'), 'safe\n')
  const archivePath = path.join(fixture, RELEASE_ASSETS.archive)
  await tar.c({ cwd: fixture, file: archivePath, gzip: true, portable: true }, ['safe.txt', 'safe.txt'])
  const archive = await readFile(archivePath)
  const manifest = {
    archive: { sha256: sha256(archive) },
    files: [{ path: 'safe.txt', sha256: sha256(Buffer.from('safe\n')) }],
  }
  await assert.rejects(extractVerifiedArchive(archive, manifest), /duplicate entry safe\.txt/i)
})
