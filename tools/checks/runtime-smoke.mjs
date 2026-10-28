#!/usr/bin/env node
/**
 * Runtime smoke test for the built artifacts.
 *
 * The test runner (vitest 4) needs Node.js 20+, but the library itself declares
 * node >=18. This script is the only way to actually verify that lower bound:
 * it imports both builds with plain `node` and exercises the public API.
 *
 * Usage: node tools/checks/runtime-smoke.mjs
 */

import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const failures = []

function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok)
    failures.push(`${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`)
}

const esm = await import('../../lib/esm/ledger/index.js')
const cjs = require('../../lib/cjs/ledger/index.js')
const root = await import('../../lib/esm/index.js')

console.log(`node ${process.version}`)

check('esm: clean document', esm.repair('{"a":1}').verdict, 'ok')
check('esm: invented value', esm.repair('[{"id":1},{"id":').counts.fabricated, 1)
check('esm: retyped literal', esm.repair('{"a":NaN}').loss, 'data')
check('esm: diagnose', esm.diagnose('{a:1}').defects.length, 1)
check('esm: verify', esm.verify('{"a":1,"b":2}', '{"a":1}').loss, 'data')
check('cjs: verdict', cjs.repair('{a:1,}').verdict, 'cosmetic')
check('cjs: ledger kinds', [...new Set(cjs.repair('{a:1,}').ledger.map((e) => e.kind))].sort(), [
  'requoted',
  'structural'
])
check('upstream api intact', root.jsonrepair("{name: 'John'}"), '{"name": "John"}')

if (failures.length) {
  console.error(`\n${failures.length} failure(s)`)
  for (const failure of failures) console.error(`  ${failure}`)
  process.exit(1)
}
console.log('\nruntime smoke: all checks passed')
