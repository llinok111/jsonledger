#!/usr/bin/env node

/**
 * Record the sha256 of every file that came from the upstream repository at the
 * fork commit. `npm run exactness:check` then proves that the repair engine was
 * not modified by this derivative.
 *
 * Files this derivative owns are excluded and listed in NOTICE.md.
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const FORK_COMMIT = '4a80ed87fb1155db064945bc2aa4f6b4f4e89c27'

export const OWNED_BY_DERIVATIVE = [
  'package.json',
  'package-lock.json',
  'README.md',
  // everything else under these paths is new
  'bin/jsonledger.js',
  'src/ledger',
  'test-lib/ledger-cli.test.js',
  'test-lib/ledger-lib.test.js',
  'tools/bench',
  'tools/checks',
  'docs/jsonledger.md',
  'NOTICE.md',
  '.github/workflows/ledger.yml'
]

const git = (args) =>
  execFileSync('git', args, { cwd: ROOT, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 })

const paths = git(['ls-tree', '-r', '--name-only', FORK_COMMIT])
  .toString('utf8')
  .split('\n')
  .filter(Boolean)

const owned = (path) =>
  OWNED_BY_DERIVATIVE.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))

const files = {}
for (const path of paths) {
  if (owned(path)) continue
  const content = git(['show', `${FORK_COMMIT}:${path}`])
  files[path] = createHash('sha256').update(content).digest('hex')
}

const target = join(ROOT, 'tools', 'checks', 'upstream-baseline.json')
writeFileSync(target, `${JSON.stringify({ forkCommit: FORK_COMMIT, files }, null, 2)}\n`)
console.log(
  `recorded ${Object.keys(files).length} upstream files at ${FORK_COMMIT.slice(0, 7)} -> ${target}`
)
