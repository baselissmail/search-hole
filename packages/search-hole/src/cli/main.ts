#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * The `searchhole` entry point (the tsdown entry, ADR-0002). It wires the real process
 * into `runCli` and sets the exit code. All behaviour lives in `run.ts`.
 *
 * `mcp` resolves only after the gateway's stdin has closed, so by then it is done like any
 * other command. Once a command is done, a short watchdog exits the process if a lingering
 * handle (an idle HTTP socket, say) keeps the event loop busy. It is skipped only when the
 * gateway is still serving (`keepAlive`).
 */

// No top-level await: this module must finish evaluating before any lazily loaded command
// chunk runs. A chunk that imports from the entry chunk would otherwise wait for this module,
// which waits for the chunk: a deadlock ("unsettled top-level await").
//
// The entry stays tiny and loads the CLI dynamically, so the bundler keeps each command's code in
// its own chunk instead of folding it into the file every start parses.
async function main(): Promise<void> {
  const [{ createNodeIo }, { runCli }] = await Promise.all([import('./io.ts'), import('./run.ts')])
  const argv = process.argv.slice(2)
  const entry = process.argv[1]
  const outcome = await runCli(
    argv,
    createNodeIo({ gateway: argv[0] === 'mcp', ...(entry === undefined ? {} : { entry }) }),
  )
  process.exitCode = outcome.code
  if (!outcome.keepAlive) setTimeout(() => process.exit(outcome.code), 1500).unref()
}

void main()
