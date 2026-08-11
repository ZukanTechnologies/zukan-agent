import { doctorRelease } from './doctor.mjs'
import { createGitHubClient } from './github.mjs'
import { installRelease } from './install.mjs'
import { publishChange } from './publish.mjs'
import { updateRelease } from './update.mjs'
import { checkForUpdate } from './updates.mjs'
import { verifySigstoreRelease } from './verify.mjs'

const usage = 'Usage: zukan-agent <install|update> [--release <tag>] [--pr] [--migrate-legacy] | doctor'

function parse(arguments_) {
  const [command, ...rest] = arguments_
  if (command === 'doctor') {
    if (rest.length) throw new Error(`${usage}; doctor does not accept options`)
    return { command }
  }
  if (command === 'install' || command === 'update') {
    const selection = { command, publish: false, migrateLegacy: false }
    for (let index = 0; index < rest.length; index += 1) {
      if (rest[index] === '--pr' && !selection.publish) selection.publish = true
      else if (rest[index] === '--migrate-legacy' && !selection.migrateLegacy) selection.migrateLegacy = true
      else if (rest[index] === '--release' && !selection.release && rest[index + 1]) selection.release = rest[++index]
      else throw new Error(`${usage}; each option may appear once and --release requires exactly one tag`)
    }
    if (selection.migrateLegacy && command !== 'update') throw new Error('--migrate-legacy is valid only with update')
    return selection
  }
  throw new Error(`${usage}; unknown command`)
}

export async function runCli(arguments_, dependencies = {}) {
  const selection = parse(arguments_)
  const target = (dependencies.cwd ?? process.cwd)()
  const github = dependencies.github ?? createGitHubClient()
  const verifySigstore = dependencies.verifySigstore ?? verifySigstoreRelease
  const updateChecker = dependencies.checkForUpdate ?? checkForUpdate
  const updateNotice = async (installedRelease) => {
    const update = await updateChecker({ target, installedRelease, github }).catch(() => ({ status: 'unavailable' }))
    if (update.status !== 'available') return ''
    return ` Update available: installed ${update.installedRelease}, latest stable ${update.availableRelease}. Review locally with npx @zukantech/agent update --release ${update.availableRelease}; add --pr to publish.`
  }
  if (selection.command === 'doctor') {
    const result = await (dependencies.doctor ?? doctorRelease)({ target, github, verifySigstore })
    return `Zukan agent workflows are healthy at ${result.release} (${result.revision.slice(0, 12)}).${await updateNotice(result.release)}`
  }
  const operation = () => (selection.command === 'install' ? dependencies.install ?? installRelease : dependencies.update ?? updateRelease)({
    target, requestedRelease: selection.release, migrateLegacy: selection.migrateLegacy, github, verifySigstore,
  })
  const result = selection.publish
    ? await (dependencies.publish ?? publishChange)({ target, operation })
    : await operation()
  const verb = result.status === 'installed' ? 'Installed' : 'Updated'
  const publication = result.pullRequest ? ` Pull request: ${result.pullRequest}.` : ''
  const notice = selection.release ? await updateNotice(result.release) : ''
  return `${verb} ${result.release} (${result.revision.slice(0, 12)}).${publication} Run npx @zukantech/agent doctor to verify the pin.${notice}`
}
