/**
 * Benchmark: does the ledger actually tell you something jsonrepair does not?
 *
 * For every document in a corpus we generate corruptions with known ground truth
 * and compare two things:
 *   - what jsonrepair produced (and whether it still means the same thing)
 *   - what jsonledger said about it
 *
 * Usage: node tools/bench/run.mjs [roots...] [--limit N] [--json file]
 */

import { writeFileSync } from 'node:fs'
import { jsonrepair } from '../../lib/esm/index.js'
import { repair } from '../../lib/esm/ledger/index.js'
import {
  COSMETIC_CLASSES,
  corrupt,
  deepEqual,
  LOSSY_CLASSES,
  loadCorpus,
  mulberry32
} from './corpus.mjs'

const argv = process.argv.slice(2)
const roots = argv.filter(
  (a) =>
    !a.startsWith('--') &&
    argv[argv.indexOf(a) - 1] !== '--limit' &&
    argv[argv.indexOf(a) - 1] !== '--json'
)
const limitArg = argv.indexOf('--limit')
const limit = limitArg === -1 ? 600 : Number(argv[limitArg + 1])
const jsonArg = argv.indexOf('--json')
const jsonOut = jsonArg === -1 ? null : argv[jsonArg + 1]
const seedArg = argv.indexOf('--seed')
const seed = seedArg === -1 ? 20261028 : Number(argv[seedArg + 1])

const searchRoots = roots.length ? roots : ['node_modules']
const docs = loadCorpus(searchRoots, { limit, maxSize: 60_000 })
if (docs.length === 0) {
  console.error(`no JSON files found under: ${searchRoots.join(', ')}`)
  process.exit(1)
}

function parse(text) {
  try {
    return { ok: true, value: JSON.parse(text) }
  } catch (error) {
    return { ok: false, error: error.message }
  }
}

function median(values) {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

// ---------------------------------------------------------------- zero change
let unchanged = 0
let upstreamUnchanged = 0
let cleanOk = 0
const upstreamMs = []
const oursMs = []
for (const doc of docs) {
  let t = performance.now()
  const out = jsonrepair(doc.text)
  upstreamMs.push(performance.now() - t)
  if (out === doc.text) upstreamUnchanged++

  t = performance.now()
  const result = repair(doc.text)
  oursMs.push(performance.now() - t)
  if (result.output === doc.text) unchanged++
  if (result.verdict === 'ok') cleanOk++
}

// ---------------------------------------------------------------- corruptions
const rows = new Map()
for (const cls of [...COSMETIC_CLASSES, ...LOSSY_CLASSES]) {
  rows.set(cls, {
    cls,
    kind: COSMETIC_CLASSES.includes(cls) ? 'cosmetic' : 'lossy',
    n: 0,
    ours_ok: 0,
    ours_cosmetic: 0,
    ours_review: 0,
    ours_reject: 0,
    ours_unrepairable: 0,
    up_same: 0,
    up_drift: 0,
    up_threw: 0,
    false_alarm: 0,
    missed_drift: 0,
    detected: 0,
    missed: 0,
    invented: 0,
    dropped: 0,
    retyped: 0,
    examples: [],
    missExamples: []
  })
}

for (const doc of docs) {
  const rand = mulberry32(seed ^ doc.text.length ^ doc.text.charCodeAt(0))
  for (const cls of [...COSMETIC_CLASSES, ...LOSSY_CLASSES]) {
    const corrupted = corrupt(doc.text, doc.value, cls, rand)
    if (corrupted === null || corrupted === doc.text) continue
    const row = rows.get(cls)
    row.n++

    let upstreamState = 'threw'
    let upstreamOutput = null
    try {
      upstreamOutput = jsonrepair(corrupted)
      const parsed = parse(upstreamOutput)
      upstreamState = parsed.ok && deepEqual(parsed.value, doc.value) ? 'same' : 'drift'
    } catch {
      upstreamState = 'threw'
    }

    const result = repair(corrupted)
    const bucket = {
      ok: 'ours_ok',
      cosmetic: 'ours_cosmetic',
      review: 'ours_review',
      reject: 'ours_reject',
      unrepairable: 'ours_unrepairable'
    }[result.verdict]
    row[bucket]++
    row[`up_${upstreamState}`]++
    row.invented += result.counts.fabricated
    row.dropped += result.counts.dropped
    row.retyped += result.counts.coerced

    const flagged =
      result.loss === 'data' || result.loss === 'truncated' || result.verdict === 'unrepairable'
    if (row.kind === 'cosmetic') {
      if (upstreamState === 'same' && flagged) row.false_alarm++
      if (upstreamState === 'drift' && !flagged) row.missed_drift++
    } else if (flagged) row.detected++
    else {
      row.missed++
      if (row.missExamples.length < 4) {
        row.missExamples.push({
          path: doc.path,
          corrupted: corrupted.length > 220 ? `${corrupted.slice(0, 220)}...` : corrupted,
          upstream: upstreamOutput === null ? '(threw)' : upstreamOutput.slice(0, 220)
        })
      }
    }

    if (row.examples.length < 3 && flagged && row.kind === 'cosmetic') {
      row.examples.push({
        path: doc.path,
        verdict: result.verdict,
        loss: result.loss,
        upstream: upstreamState
      })
    }
  }
}

const table = [...rows.values()]
const pct = (a, b) => (b === 0 ? 'n/a' : `${((a / b) * 100).toFixed(1)}%`)

console.log(`\ncorpus: ${docs.length} valid JSON documents from ${searchRoots.join(', ')}\n`)
console.log('zero-change guarantee (valid JSON in, same bytes out)')
console.log(`  jsonrepair : ${upstreamUnchanged}/${docs.length}`)
console.log(`  jsonledger : ${unchanged}/${docs.length}   verdict=ok: ${cleanOk}/${docs.length}`)
console.log(
  `  median time per document: jsonrepair ${median(upstreamMs).toFixed(3)} ms, jsonledger ${median(oursMs).toFixed(3)} ms\n`
)

const pad = (v, n) => String(v).padEnd(n)
console.log(
  pad('class', 16) +
    pad('kind', 10) +
    pad('n', 6) +
    pad('same', 7) +
    pad('drift', 7) +
    pad('threw', 7) +
    pad('flagged', 9) +
    pad('false', 7) +
    pad('missed', 7)
)
console.log('-'.repeat(76))
for (const row of table) {
  console.log(
    pad(row.cls, 16) +
      pad(row.kind, 10) +
      pad(row.n, 6) +
      pad(row.up_same, 7) +
      pad(row.up_drift, 7) +
      pad(row.up_threw, 7) +
      pad(
        row.kind === 'lossy'
          ? `${row.detected} (${pct(row.detected, row.n)})`
          : pct(row.n - row.false_alarm, row.n),
        9
      ) +
      pad(row.kind === 'cosmetic' ? row.false_alarm : '-', 7) +
      pad(row.kind === 'cosmetic' ? row.missed_drift : row.detected === row.n ? 0 : row.missed, 7)
  )
}

const cosmetic = table.filter((r) => r.kind === 'cosmetic')
const lossy = table.filter((r) => r.kind === 'lossy')
const sum = (list, key) => list.reduce((a, r) => a + r[key], 0)
console.log('\nsummary')
console.log(
  `  cosmetic corruptions : n=${sum(cosmetic, 'n')}  false alarms=${sum(cosmetic, 'false_alarm')}  upstream semantic drift=${sum(cosmetic, 'up_drift')}  drift missed by ledger=${sum(cosmetic, 'missed_drift')}`
)
console.log(
  `  lossy corruptions    : n=${sum(lossy, 'n')}  detected=${sum(lossy, 'detected')}  missed=${sum(lossy, 'missed')}`
)
console.log(
  `  upstream silent successes on lossy input: ${sum(lossy, 'up_same') + sum(lossy, 'up_drift')}/${sum(lossy, 'n')} (drift=${sum(lossy, 'up_drift')}, threw=${sum(lossy, 'up_threw')})`
)

if (argv.includes('--show-misses')) {
  console.log('\nmissed lossy cases')
  for (const row of table) {
    for (const miss of row.missExamples) {
      console.log(`  [${row.cls}] ${miss.path}`)
      console.log(`    in : ${JSON.stringify(miss.corrupted)}`)
      console.log(`    out: ${JSON.stringify(miss.upstream)}`)
    }
  }
}

if (jsonOut) {
  writeFileSync(
    jsonOut,
    `${JSON.stringify(
      {
        corpus: { roots: searchRoots, documents: docs.length, seed },
        zeroChange: { jsonrepair: upstreamUnchanged, jsonledger: unchanged, ok: cleanOk },
        timing: { jsonrepairMedianMs: median(upstreamMs), jsonledgerMedianMs: median(oursMs) },
        rows: table,
        summary: {
          cosmetic: {
            n: sum(cosmetic, 'n'),
            falseAlarms: sum(cosmetic, 'false_alarm'),
            upstreamDrift: sum(cosmetic, 'up_drift'),
            missedDrift: sum(cosmetic, 'missed_drift')
          },
          lossy: {
            n: sum(lossy, 'n'),
            detected: sum(lossy, 'detected'),
            missed: sum(lossy, 'missed')
          }
        }
      },
      null,
      2
    )}\n`
  )
  console.log(`\nwrote ${jsonOut}`)
}
