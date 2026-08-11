import { doctorRelease } from './doctor.mjs'
import { createGitHubClient } from './github.mjs'
import { installRelease } from './install.mjs'
import { verifySigstoreRelease } from './verify.mjs'

const usage = 'Usage: zukan-agent <install [--release <tag>] | doctor>'

function parse(arguments_) {
  const [command, ...rest] = arguments_
  if (command === 'doctor') {
    if (rest.length) throw new Error(`${usage}; doctor does not accept options`)
    return { command }
  }
  if (command === 'install') {
    if (rest.includes('--pr')) throw new Error('--pr belongs to the reviewable update workflow and is not available during first install')
    if (rest.length === 0) return { command }
    if (rest.length === 2 && rest[0] === '--release' && rest[1]) return { command, release: rest[1] }
    throw new Error(`${usage}; --release requires exactly one tag`)
  }
  throw new Error(`${usage}; unknown command`)
}

export async function runCli(arguments_, dependencies = {}) {
  const selection = parse(arguments_)
  const target = (dependencies.cwd ?? process.cwd)()
  if (selection.command === 'doctor') {
    const result = await (dependencies.doctor ?? doctorRelease)({ target })
    return `Zukan agent workflows are healthy at ${result.release} (${result.revision.slice(0, 12)}).`
  }
  const result = await (dependencies.install ?? installRelease)({
    target,
    requestedRelease: selection.release,
    github: dependencies.github ?? createGitHubClient(),
    verifySigstore: dependencies.verifySigstore ?? verifySigstoreRelease,
  })
  return `Installed ${result.release} (${result.revision.slice(0, 12)}). Run npx @zukantech/agent doctor to verify the pin.`
}
