import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { pathIsUnsafe, validateReleaseName } from './contracts.mjs'

const execFileAsync = promisify(execFile)

async function defaultRunner(command, args, target) {
  const { stdout } = await execFileAsync(command, args, { cwd: target, encoding: 'buffer', maxBuffer: 10 * 1024 * 1024, timeout: 60_000 })
  return stdout
}

function nulPaths(bytes) {
  return bytes.toString('utf8').split('\0').filter(Boolean)
}

function installerOwned(relative) {
  return relative === 'AGENTS.md'
    || relative === '.agents/zukan/release-lock.json'
    || relative === '.agents/zukan/workflow'
    || relative === '.agents/zukan/bin'
    || /^\.agents\/zukan\/(?:vendor|evidence)\/[^/]+(?:\/.*)?$/.test(relative)
    || /^\.agents\/skills\/[^/]+(?:\/.*)?$/.test(relative)
    || /^\.claude\/skills\/[^/]+(?:\/.*)?$/.test(relative)
}

function inDeclaredScope(relative, declared) {
  return declared.some((root) => relative === root || relative.startsWith(`${root}/`))
}

function exactSet(left, right) {
  return left.size === right.size && [...left].every((entry) => right.has(entry))
}

export async function publishChange({ target, operation, runner = defaultRunner }) {
  const run = async (command, args, label) => {
    try { return await runner(command, args, target) } catch { throw new Error(`${label} failed; inspect the repository and continue with its approved GitHub workflow`) }
  }
  if ((await run('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], 'working tree check')).length) {
    throw new Error('--pr requires a clean working tree so only the bounded workflow change can be published')
  }
  const branch = (await run('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], 'current branch check')).toString('utf8').trim()
  const defaultBranch = (await run('gh', ['repo', 'view', '--json', 'defaultBranchRef', '--jq', '.defaultBranchRef.name'], 'default branch discovery')).toString('utf8').trim()
  if (!branch || branch !== defaultBranch) throw new Error(`--pr must start from the repository default branch (${defaultBranch || 'unknown'})`)
  await run('git', ['fetch', '--no-tags', 'origin', defaultBranch], 'default branch refresh')
  const localRevision = (await run('git', ['rev-parse', 'HEAD'], 'local revision check')).toString('utf8').trim()
  const remoteRevision = (await run('git', ['rev-parse', `refs/remotes/origin/${defaultBranch}`], 'remote revision check')).toString('utf8').trim()
  if (!/^[a-f0-9]{40}$/.test(localRevision) || localRevision !== remoteRevision) {
    throw new Error(`--pr requires the local ${defaultBranch} branch to exactly match origin/${defaultBranch}`)
  }

  const result = await operation()
  validateReleaseName(result.release)
  if (!Array.isArray(result.changedPaths) || result.changedPaths.length === 0) throw new Error('the operation did not declare a bounded repository change')
  const declared = [...new Set(result.changedPaths)]
  if (declared.some((relative) => typeof relative !== 'string' || pathIsUnsafe(relative) || !installerOwned(relative))) {
    throw new Error('the operation declared a path outside the bounded installer surface')
  }
  const tracked = nulPaths(await run('git', ['diff', '--name-only', '-z', 'HEAD', '--'], 'change inspection'))
  const untracked = nulPaths(await run('git', ['ls-files', '--others', '--exclude-standard', '-z'], 'untracked change inspection'))
  const ignored = nulPaths(await run('git', ['ls-files', '--others', '--ignored', '--exclude-standard', '-z', '--', ...declared], 'ignored installer change inspection'))
  const actual = new Set([...tracked, ...untracked, ...ignored])
  const outside = [...actual].filter((relative) => !installerOwned(relative) || !inDeclaredScope(relative, declared))
  const uncovered = declared.filter((root) => ![...actual].some((relative) => relative === root || relative.startsWith(`${root}/`)))
  if (actual.size === 0 || outside.length || uncovered.length) {
    throw new Error(`operation produced a change outside the bounded installer diff${outside.length ? `: ${outside.join(', ')}` : ''}`)
  }

  const releaseSlug = result.release.replace(/[^0-9A-Za-z._-]/g, '-')
  const publicationBranch = `chore/zukan-agent-${releaseSlug}`
  await run('git', ['switch', '-c', publicationBranch], 'publication branch creation')
  await run('git', ['add', '-f', '-A', '--', ...declared], 'bounded change staging')
  const staged = new Set(nulPaths(await run('git', ['diff', '--cached', '--name-only', '-z'], 'staged change inspection')))
  if (!exactSet(staged, actual)) throw new Error('the staged diff does not exactly match the bounded installer change; nothing was committed')
  const stagedTree = (await run('git', ['write-tree'], 'staged tree snapshot')).toString('utf8').trim()
  if (!/^[a-f0-9]{40}$/.test(stagedTree)) throw new Error('the staged tree snapshot is invalid; nothing was committed')

  const action = result.status === 'installed' ? 'enable' : 'update'
  const title = `chore(agent): ${action} Zukan workflows at ${result.release}`
  await run('git', ['-c', 'core.hooksPath=/dev/null', 'commit', '-m', title], 'workflow change commit')
  const committedTree = (await run('git', ['rev-parse', 'HEAD^{tree}'], 'committed tree inspection')).toString('utf8').trim()
  if (committedTree !== stagedTree) throw new Error('the committed workflow bytes differ from the validated staged tree; nothing was pushed')
  const committed = new Set(nulPaths(await run('git', ['diff-tree', '--no-commit-id', '--name-only', '-r', '-z', 'HEAD'], 'committed change inspection')))
  if (!exactSet(committed, actual)) throw new Error('the committed diff does not exactly match the bounded installer change; nothing was pushed')
  if ((await run('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], 'post-commit working tree check')).length) {
    throw new Error('the working tree changed after the validated commit; nothing was pushed')
  }
  await run('git', ['push', '--set-upstream', 'origin', publicationBranch], 'workflow branch push')
  const body = [
    `Pins the verified Zukan workflow release \`${result.release}\` at revision \`${result.revision}\`.`,
    '',
    'The public bootstrap verified producer identity, signature evidence, tag, revision, archive, and file digests before generating this bounded diff.',
  ].join('\n')
  const pullRequest = (await run('gh', ['pr', 'create', '--base', defaultBranch, '--head', publicationBranch, '--title', title, '--body', body], 'pull request creation')).toString('utf8').trim()
  if (!/^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+$/.test(pullRequest)) throw new Error('pull request creation returned an invalid URL')
  return { ...result, pullRequest, branch: publicationBranch }
}
