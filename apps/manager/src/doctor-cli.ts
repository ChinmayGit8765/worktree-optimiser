#!/usr/bin/env node
import { runDoctor, type CheckStatus } from './doctor.js'

/**
 * `npm run doctor`. Exits non-zero when any check fails, so it is usable as a
 * preflight in CI or a setup script.
 */

const COLOUR = process.stdout.isTTY && !process.env.NO_COLOR
const paint = (code: string, text: string) => (COLOUR ? `\u001b[${code}m${text}\u001b[0m` : text)

const MARK: Record<CheckStatus, string> = {
  ok: paint('32', 'ok  '),
  warn: paint('33', 'warn'),
  fail: paint('31', 'FAIL'),
}

const report = await runDoctor()

console.log(`\nworktree-optimiser doctor — ${report.platform}\n`)

let width = 0
for (const c of report.checks) width = Math.max(width, c.label.length)

for (const check of report.checks) {
  console.log(`  ${MARK[check.status]}  ${check.label.padEnd(width)}  ${check.detail}`)
  if (check.fix) {
    for (const line of wrap(check.fix, 76)) console.log(`        ${paint('90', line)}`)
  }
}

const failures = report.checks.filter((c) => c.status === 'fail').length
const warnings = report.checks.filter((c) => c.status === 'warn').length

console.log(
  `\n${failures === 0 ? paint('32', 'No blocking problems') : paint('31', `${failures} problem(s)`)}` +
    `${warnings ? `, ${warnings} warning(s)` : ''}.\n`,
)

process.exit(failures === 0 ? 0 : 1)

function wrap(text: string, max: number): string[] {
  const words = text.split(/\s+/)
  const lines: string[] = []
  let line = ''
  for (const word of words) {
    if (line.length + word.length + 1 > max) {
      lines.push(line)
      line = word
    } else {
      line = line ? `${line} ${word}` : word
    }
  }
  if (line) lines.push(line)
  return lines
}
