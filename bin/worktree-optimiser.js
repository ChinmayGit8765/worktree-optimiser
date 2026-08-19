#!/usr/bin/env node
/**
 * Single entry point for the installed package.
 *
 *   worktree-optimiser            start the manager + dashboard
 *   worktree-optimiser doctor     run preflight checks, exit non-zero on failure
 *   worktree-optimiser mcp        run the MCP server on stdio (for coding agents)
 *
 * Nothing here does real work; it resolves the built entry point and hands over,
 * so `npx worktree-optimiser` behaves exactly like `npm start` in a clone.
 */
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import fs from 'node:fs'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')

// Null prototype so an argument like `constructor` resolves to nothing rather
// than to something inherited from Object.prototype.
const TARGETS = Object.assign(Object.create(null), {
  start: 'apps/manager/dist/index.js',
  doctor: 'apps/manager/dist/doctor-cli.js',
  mcp: 'apps/mcp/dist/index.js',
})

const [, , rawCommand, ...rest] = process.argv

// A leading `-` is a flag for the target, not a subcommand — but it must still be
// tested against the help forms first, or `--help` resolves to `start` and boots
// the server instead of printing anything.
const isSubcommand = Boolean(rawCommand) && !rawCommand.startsWith('-')
const command = isSubcommand ? rawCommand : 'start'

if (rawCommand === 'help' || rawCommand === '--help' || rawCommand === '-h') {
  console.log(`
worktree-optimiser — run every git worktree as its own containerised dev server

  worktree-optimiser            start the manager and dashboard (default)
  worktree-optimiser doctor     check the environment and report fixes
  worktree-optimiser mcp        run the MCP server on stdio

Common environment variables:
  WT_PORT=7777                  manager port
  WT_HTTP_PORT=80               port the proxy listens on
  WT_HOST=127.0.0.1             bind interface (non-loopback requires WT_TOKEN)
  WT_MCP_ALLOW_DESTRUCTIVE      set true to expose delete_worktree over MCP

Docs: https://github.com/ChinmayGit8765/worktree-optimiser
`)
  process.exit(0)
}

const relative = TARGETS[command]
if (!relative) {
  console.error(`Unknown command "${command}". Try: start, doctor, mcp, help.`)
  process.exit(1)
}

const target = path.join(root, relative)
if (!fs.existsSync(target)) {
  // Only reachable in a source checkout that has not been built; a published
  // tarball ships dist/, and prepublishOnly guarantees it.
  console.error(
    `Missing build output: ${relative}\n` +
      `Run \`npm run build\` first (from ${root}).`,
  )
  process.exit(1)
}

// Re-expose the remaining argv to the target as if it had been invoked directly.
// The first argument is only dropped when it named a subcommand; a bare flag was
// never consumed here, so it stays in argv for the target to interpret.
process.argv = [process.argv[0], target, ...(isSubcommand ? rest : process.argv.slice(2))]

// An absolute file URL, so the import resolves against the package rather than
// whatever directory the user happened to run this from.
await import(pathToFileURL(target).href)
