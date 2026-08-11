import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

async function defaultRunner(command, args, options = {}) {
  const { stdout } = await execFileAsync(command, args, {
    cwd: options.cwd,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
    timeout: 10 * 60_000,
  })
  return stdout
}

export async function publishRelease({ root, refName, revision, packageDocument, runner = defaultRunner }) {
  const packageValue = packageDocument ?? JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
  if (packageValue.name !== '@zukantech/agent'
    || typeof packageValue.version !== 'string'
    || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/.test(packageValue.version)) {
    throw new Error('package release identity is invalid')
  }
  if (refName !== `v${packageValue.version}`) throw new Error('release tag does not exactly match the package version')
  if (!/^[a-f0-9]{40}$/.test(revision ?? '')) throw new Error('release revision is invalid')
  const head = (await runner('git', ['rev-parse', 'HEAD'], { cwd: root })).trim()
  if (head !== revision) throw new Error('checked-out release revision differs from GitHub')
  try {
    await runner('git', ['merge-base', '--is-ancestor', 'HEAD', 'refs/remotes/origin/main'], { cwd: root })
  } catch {
    throw new Error('release revision is not contained in main')
  }
  const distTag = packageValue.version.includes('-') ? 'next' : 'latest'
  await runner('npm', [
    'publish', '--ignore-scripts', '--access', 'public', '--tag', distTag,
    '--registry', 'https://registry.npmjs.org',
  ], { cwd: root })
  return { package: packageValue.name, version: packageValue.version, distTag, revision }
}
