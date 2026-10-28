// Only use native node.js APIs and references to ./lib here: this file is not transpiled.
import { describe, expect, test } from 'vitest'

describe('built package', () => {
  test('the ledger is importable through the package export map', async () => {
    const { repair } = await import('jsonledger/ledger')
    const result = repair('{"a":NaN}')
    expect(result.verdict).toBe('reject')
    expect(result.counts.coerced).toBe(1)
  })

  test('the ledger is loadable from CJS', async () => {
    const { createRequire } = await import('node:module')
    const require = createRequire(import.meta.url)
    const { diagnose } = require('jsonledger/ledger')
    expect(diagnose('{"a":1}').ok).toBe(true)
  })

  test('the formatter is a separate entry point', async () => {
    const { formatReport } = await import('jsonledger/ledger/format')
    const { repair } = await import('jsonledger/ledger')
    const text = formatReport(repair('{"a":1,}'))
    expect(text).toContain('verdict: cosmetic')
    expect(text).toContain('structure')
  })

  test('the upstream api is untouched', async () => {
    const root = await import('jsonledger')
    expect(typeof root.jsonrepair).toBe('function')
    expect(root.jsonrepair("{name: 'John'}")).toBe('{"name": "John"}')
    expect(typeof root.JSONRepairError).toBe('function')
  })

  test('the upstream streaming export is untouched', async () => {
    const stream = await import('jsonrepair/stream').catch(() => null)
    const local = await import('jsonledger/stream')
    expect(typeof local.jsonrepairTransform).toBe('function')
    if (stream) expect(typeof stream.jsonrepairTransform).toBe('function')
  })
})
