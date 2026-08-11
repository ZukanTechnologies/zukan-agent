#!/usr/bin/env node
import { runCli } from '../src/cli.mjs'

try {
  console.log(await runCli(process.argv.slice(2)))
} catch (error) {
  console.error(`zukan-agent: ${error.message}`)
  process.exitCode = 1
}
