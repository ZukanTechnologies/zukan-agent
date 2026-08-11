import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const temporary = await mkdtemp(path.join(tmpdir(), 'zukan-agent-pack-'))

try {
  const packageDocument = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
  if (packageDocument.name !== '@zukantech/agent' || packageDocument.publishConfig?.access !== 'public') {
    throw new Error('package identity or public access contract is invalid')
  }
  if (packageDocument.bin?.['zukan-agent'] !== 'bin/zukan-agent.mjs') {
    throw new Error('package executable contract is invalid')
  }
  const { stdout } = await execFileAsync('npm', [
    'pack', '--dry-run', '--json', '--cache', path.join(temporary, 'npm-cache'),
  ], { cwd: root, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 })
  const reports = JSON.parse(stdout)
  if (!Array.isArray(reports) || reports.length !== 1 || !Array.isArray(reports[0].files)) {
    throw new Error('npm pack inventory is invalid')
  }
  const files = reports[0].files.map(({ path: relative }) => relative).sort()
  const allowed = (relative) => ['LICENSE', 'README.md', 'package.json'].includes(relative)
    || ['bin/', 'src/', 'templates/'].some((prefix) => relative.startsWith(prefix))
  const forbidden = files.filter((relative) => !allowed(relative))
  if (forbidden.length) throw new Error(`public package contains forbidden paths: ${forbidden.join(', ')}`)
  for (const required of ['bin/zukan-agent.mjs', 'src/admission.mjs', 'src/install.mjs', 'src/verify.mjs', 'templates/AGENTS.md']) {
    if (!files.includes(required)) throw new Error(`public package is missing ${required}`)
  }
  const secretPatterns = [
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u,
    /\bgh(?:p|o|u|s|r)_[A-Za-z0-9_]{20,}\b/u,
    /\bgithub_pat_[A-Za-z0-9_]{20,}\b/u,
    /\b(?:ANTHROPIC|LINEAR|SENTRY|NPM)_\w*(?:TOKEN|KEY)\s*=\s*\S+/u,
  ]
  for (const relative of files) {
    const contents = await readFile(path.join(root, relative), 'utf8')
    if (secretPatterns.some((pattern) => pattern.test(contents))) {
      throw new Error(`public package contains credential-shaped content in ${relative}`)
    }
  }
  console.log(`Validated public package inventory (${files.length} files); no protected paths or credential-shaped content found.`)
} finally {
  await rm(temporary, { force: true, recursive: true })
}
