/**
 * Loads a local `.env` before anything reads `process.env`.
 *
 * The package ships an `.env.example` and the docs say to copy it, so the file
 * has to actually be read — otherwise every value in it is silently ignored and
 * the only symptom is a setting that "doesn't work".
 *
 * Real environment variables still win: `loadEnvFile` uses the same parser and
 * precedence as `--env-file`, so `WT_HTTP_PORT=8080 npm start` overrides the file.
 *
 * Import this *before* `./config.js`. ESM evaluates dependencies in import order
 * and config.ts reads `process.env` at module scope, so the order is load-bearing.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..', '..', '..')

/**
 * Loads the first `.env` found in `dirs` and returns its path, or null if none
 * existed. Only the first is used — merging two .env files would make which value
 * won depend on file order, which is not something anyone should have to reason
 * about.
 */
export function loadDotEnv(dirs: string[]): string | null {
  for (const dir of dirs) {
    const file = path.join(dir, '.env')
    if (!fs.existsSync(file)) continue

    if (typeof process.loadEnvFile !== 'function') {
      // Node 20.12 added loadEnvFile. Everything else here runs on 20.0, so this
      // degrades to "the file is ignored" rather than refusing to start — but say
      // so, because a silently ignored .env is the bug this module exists to fix.
      console.warn(
        `Ignoring ${file}: reading .env needs Node 20.12 or newer ` +
          `(running v${process.versions.node}). Export the variables instead.`,
      )
      return null
    }

    try {
      process.loadEnvFile(file)
      return file
    } catch (err) {
      // A malformed .env is worth saying out loud, but not worth refusing to
      // start over — every value in it is optional.
      console.warn(`Ignoring ${file}: ${err instanceof Error ? err.message : String(err)}`)
      return null
    }
  }
  return null
}

// The working directory first: running the installed package from a project
// directory should pick up that project's .env, not the package's own.
loadDotEnv([...new Set([process.cwd(), repoRoot])])
