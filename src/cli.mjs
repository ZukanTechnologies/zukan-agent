import { doctorRelease } from './doctor.mjs'
import { bindCapabilityPolicy, evaluateAdmission } from './admission.mjs'
import { createGitHubClient } from './github.mjs'
import { installRelease } from './install.mjs'
import { publishChange } from './publish.mjs'
import { updateRelease } from './update.mjs'
import { checkForUpdate } from './updates.mjs'
import { verifySigstoreRelease } from './verify.mjs'

const usage = 'Usage: zukan-agent <install|update> [--release <tag>] [--pr] [--migrate-legacy] | bind-policy --policy <file> --attestation <file> [--pr] | admit --route <intent> --observations <file> | doctor'

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
  if (command === 'bind-policy') {
    const selection = { command, publish: false }
    for (let index = 0; index < rest.length; index += 1) {
      if (rest[index] === '--pr' && !selection.publish) selection.publish = true
      else if (rest[index] === '--policy' && !selection.policyFile && rest[index + 1]) selection.policyFile = rest[++index]
      else if (rest[index] === '--attestation' && !selection.attestationFile && rest[index + 1]) selection.attestationFile = rest[++index]
      else throw new Error(`${usage}; each bind-policy option may appear once and requires one value`)
    }
    if (!selection.policyFile || !selection.attestationFile) throw new Error(`${usage}; bind-policy requires --policy and --attestation`)
    return selection
  }
  if (command === 'admit') {
    const selection = { command }
    for (let index = 0; index < rest.length; index += 1) {
      if (rest[index] === '--route' && !selection.route && rest[index + 1]) selection.route = rest[++index]
      else if (rest[index] === '--observations' && !selection.observationsFile && rest[index + 1]) selection.observationsFile = rest[++index]
      else throw new Error(`${usage}; each admit option may appear once and requires one value`)
    }
    if (!selection.route || !selection.observationsFile) throw new Error(`${usage}; admit requires --route and --observations`)
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
  if (selection.command === 'admit') {
    await (dependencies.doctor ?? doctorRelease)({ target, github, verifySigstore })
    return (dependencies.admit ?? evaluateAdmission)({
      target,
      route: selection.route,
      observationsFile: selection.observationsFile,
    })
  }
  if (selection.command === 'bind-policy') {
    const operation = async () => {
      await (dependencies.doctor ?? doctorRelease)({ target, github, verifySigstore })
      return (dependencies.bind ?? bindCapabilityPolicy)({
        target,
        policyFile: selection.policyFile,
        attestationFile: selection.attestationFile,
      })
    }
    const result = selection.publish
      ? await (dependencies.publish ?? publishChange)({ target, operation })
      : await operation()
    const publication = result.pullRequest ? ` Pull request: ${result.pullRequest}.` : ''
    return `Bound capability policy to ${result.release} (${result.revision.slice(0, 12)}).${publication} Run npx @zukantech/agent doctor to verify the pin.`
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
