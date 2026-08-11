#!/usr/bin/env node
import { runCli } from '../src/cli.mjs'

try {
  const result = await runCli(process.argv.slice(2))
  if (result && typeof result === 'object') {
    console.log(result.output)
    process.exitCode = result.exitCode
  } else {
    console.log(result)
  }
} catch (error) {
  console.error(`zukan-agent: ${error.message}`)
  process.exitCode = 1
}
