#!/usr/bin/env node

import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { publishRelease } from './release-contract.mjs'

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))

try {
  const result = await publishRelease({
    root,
    refName: process.env.GITHUB_REF_NAME,
    revision: process.env.GITHUB_SHA,
  })
  process.stdout.write(`Published ${result.package}@${result.version} from ${result.revision} under ${result.distTag}.\n`)
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
}
