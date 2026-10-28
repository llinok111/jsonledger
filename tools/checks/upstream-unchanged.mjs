#!/usr/bin/env node
/**
 * Verify that every file inherited from upstream is still byte identical, and that
 * no upstream file was deleted. Fails with exit code 1 on any difference.
 *
 * The repair engine is jsonrepair's, not ours: if this check fails, the ledger's
 * claims about upstream behaviour no longer hold.
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const baseline = JSON.parse(
  readFileSync(join(ROOT, 'tools', 'checks', 'upstream-baseline.json'), 'utf8')
)

const modified = []
const missing = []
for (const [path, expected] of Object.entries(baseline.files)) {
  const full = join(ROOT, path)
  if (!existsSync(full)) {
    missing.push(path)
    continue
  }
  // Compare on LF: the baseline comes from git blobs, the working tree may be CRLF
  // on Windows checkouts with core.autocrlf. Line endings are not a code change.
  const normalised = readFileSync(full, 'utf8').split('\r\n').join('\n')
  const actual = createHash('sha256').update(normalised, 'utf8').digest('hex')
  if (actual !== expected) modified.push(path)
}

const total = Object.keys(baseline.files).length
if (modified.length === 0 && missing.length === 0) {
  console.log(
    `exactness: ${total}/${total} upstream files unchanged (fork ${baseline.forkCommit.slice(0, 7)})`
  )
  process.exit(0)
}

console.error(`exactness: ${modified.length} modified, ${missing.length} missing out of ${total}`)
for (const path of modified) console.error(`  modified ${path}`)
for (const path of missing) console.error(`  missing  ${path}`)
process.exit(1)
