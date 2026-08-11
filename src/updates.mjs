import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { sha256, validateReleaseName } from './contracts.mjs'

export const UPDATE_CACHE_TTL_MS = 24 * 60 * 60 * 1000

function defaultCacheRoot() {
  if (process.env.XDG_CACHE_HOME) return path.join(process.env.XDG_CACHE_HOME, 'zukan-agent')
  return process.platform === 'darwin'
    ? path.join(homedir(), 'Library', 'Caches', 'zukan-agent')
    : path.join(homedir(), '.cache', 'zukan-agent')
}

function result(installedRelease, availableRelease, cached) {
  return installedRelease === availableRelease
    ? { status: 'current', installedRelease, availableRelease, cached }
    : { status: 'available', installedRelease, availableRelease, cached }
}

export async function checkForUpdate({ target, installedRelease, github, cacheRoot = defaultCacheRoot(), now = Date.now }) {
  validateReleaseName(installedRelease, 'installed release')
  const checkedAt = now()
  const cacheFile = path.join(cacheRoot, `${sha256(Buffer.from(path.resolve(target)))}.json`)
  try {
    const cached = JSON.parse(await readFile(cacheFile, 'utf8'))
    if (cached?.schemaVersion === 1
      && cached.installedRelease === installedRelease
      && Number.isSafeInteger(cached.checkedAt)
      && checkedAt >= cached.checkedAt
      && checkedAt - cached.checkedAt < UPDATE_CACHE_TTL_MS) {
      return result(installedRelease, validateReleaseName(cached.availableRelease, 'cached available release'), true)
    }
  } catch {}

  try {
    const release = await github.resolveRelease()
    if (release.draft || release.prerelease) return { status: 'unavailable' }
    const availableRelease = validateReleaseName(release.tagName, 'available release')
    try {
      await mkdir(cacheRoot, { recursive: true, mode: 0o700 })
      const temporary = `${cacheFile}.${process.pid}.tmp`
      await writeFile(temporary, `${JSON.stringify({ schemaVersion: 1, checkedAt, installedRelease, availableRelease })}\n`, { mode: 0o600 })
      await rename(temporary, cacheFile)
    } catch {}
    return result(installedRelease, availableRelease, false)
  } catch {
    return { status: 'unavailable' }
  }
}
