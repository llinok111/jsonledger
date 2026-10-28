import { describe, expect, test } from 'vitest'
import { repair, verify } from './index.js'

const parse = (text: string | null) => JSON.parse(text as string)

describe('repair: clean input', () => {
  test('valid JSON is returned byte for byte', () => {
    const input = '{\n  "a": 1,\n  "b": [1, 2]\n}\n'
    const result = repair(input)
    expect(result.verdict).toBe('ok')
    expect(result.loss).toBe('none')
    expect(result.changed).toBe(false)
    expect(result.output).toBe(input)
    expect(result.ledger).toEqual([])
    expect(result.defects).toEqual([])
  })

  test('whitespace around the document is preserved', () => {
    const input = '   {"a":1}   '
    expect(repair(input).output).toBe(input)
  })
})

describe('repair: lossless fixes', () => {
  const cases: Array<[string, string, unknown]> = [
    ['trailing comma', '{"a":1,"b":[1,2,],}', { a: 1, b: [1, 2] }],
    ['single quotes', "{'a':'x','b':2}", { a: 'x', b: 2 }],
    ['unquoted keys', '{a:1,b:2}', { a: 1, b: 2 }],
    ['comment', '{"a":1 /* why */ , "b":2}', { a: 1, b: 2 }],
    ['bom', '\ufeff{"a":1}', { a: 1 }],
    ['missing colon', '{"a" 1}', { a: 1 }],
    ['missing comma', '{"a":1 "b":2}', { a: 1, b: 2 }],
    ['markdown fence', '```json\n{"a":1}\n```', { a: 1 }],
    ['raw newline in string', '{"a":"line1\nline2"}', { a: 'line1\nline2' }]
  ]

  for (const [name, input, expected] of cases) {
    test(`${name} is cosmetic and keeps the value`, () => {
      const result = repair(input)
      expect(['ok', 'cosmetic']).toContain(result.verdict)
      expect(result.loss).toBe('cosmetic')
      expect(result.counts.fabricated).toBe(0)
      expect(result.counts.dropped).toBe(0)
      expect(result.counts.restructured).toBe(0)
      expect(parse(result.output)).toEqual(expected)
    })
  }

  test('a windows path is only requoted, never reported as data loss', () => {
    const result = repair('{"p":C:\\temp\\x}')
    expect(result.verdict).toBe('cosmetic')
    expect(result.counts.dropped).toBe(0)
    expect(result.counts.fabricated).toBe(0)
    expect(parse(result.output).p).toBe('C:\\temp\\x')
  })

  test('a bare url is only requoted', () => {
    const result = repair('{"u":https://example.com/a?b=1}')
    expect(result.loss).toBe('cosmetic')
    expect(parse(result.output).u).toBe('https://example.com/a?b=1')
  })
})

describe('repair: the repair rewrote data', () => {
  test('NaN is retyped to a string and reported as data loss', () => {
    const result = repair('{"a":NaN,"b":Infinity}')
    expect(result.verdict).toBe('reject')
    expect(result.loss).toBe('data')
    expect(result.counts.coerced).toBe(2)
    const events = result.ledger.filter((e) => e.kind === 'coerced')
    expect(events.map((e) => e.path)).toEqual(['$.a', '$.b'])
    expect(events.every((e) => e.severity === 'data')).toBe(true)
    expect(events[0].preview).toBe('"NaN"')
    expect(parse(result.output)).toEqual({ a: 'NaN', b: 'Infinity' })
  })

  test('a truncated array element is reported as invented, with its path', () => {
    const result = repair('[{"id":1},{"id":2},{"id":')
    expect(result.verdict).toBe('reject')
    expect(result.counts.fabricated).toBe(1)
    const invented = result.ledger.find((e) => e.kind === 'fabricated')
    expect(invented?.path).toBe('$[2].id')
    expect(invented?.preview).toBe('null')
    expect(parse(result.output)).toEqual([{ id: 1 }, { id: 2 }, { id: null }])
  })

  test('an ellipsis placeholder is unknown content, not data loss', () => {
    const result = repair('{"a":1, ...}')
    expect(result.loss).toBe('truncated')
    expect(result.verdict).toBe('review')
    expect(result.ledger.some((e) => e.kind === 'elided')).toBe(true)
    expect(result.counts.dropped).toBe(0)
  })

  test('a doubled array comma changes nesting and is rejected', () => {
    const result = repair('[1,2,,3]')
    expect(result.output).toBe('[\n[1,2],3\n]')
    expect(result.counts.restructured).toBeGreaterThan(0)
    expect(result.verdict).toBe('reject')
    expect(
      result.ledger.some((e) => e.kind === 'restructured' && e.detail.includes('$[0] -> $[0][0]'))
    ).toBe(true)
  })

  test('an empty object wrapped in an array is caught by container counting', () => {
    const result = repair('[{},,{"a":1}]')
    expect(result.counts.restructured).toBe(1)
    expect(result.verdict).toBe('reject')
    expect(result.ledger.some((e) => e.detail.startsWith('container count changed'))).toBe(true)
  })

  test('a truncated object is reviewable, not silently accepted', () => {
    const result = repair('{"name":"svc","retries":3,"timeout":30')
    expect(result.verdict).toBe('review')
    expect(result.loss).toBe('truncated')
    const event = result.ledger.find((e) => e.kind === 'truncated')
    expect(event?.line).toBe(1)
    expect(event?.detail).toContain('unknowable')
  })

  test('a numeric looking token becomes a string and asks for review', () => {
    const result = repair('{"version":0.0.1}')
    expect(result.verdict).toBe('review')
    expect(result.loss).toBe('type')
    expect(result.counts.coerced).toBe(1)
    expect(result.ledger[0].severity).toBe('warn')
  })
})

describe('repair: refusal and failure', () => {
  test('the safe policy withholds a lossy document', () => {
    const result = repair('{"a":NaN}', { policy: 'safe' })
    expect(result.output).toBeNull()
    expect(result.verdict).toBe('reject')
    expect(result.refused).toContain('refused')
  })

  test('the safe policy still returns lossless output', () => {
    const result = repair('{a:1}', { policy: 'safe' })
    expect(result.output).toBe('{"a":1}')
    expect(result.refused).toBeUndefined()
  })

  test('an unrepairable document reports the upstream position', () => {
    const result = repair('{"a":1} extra stuff here')
    expect(result.verdict).toBe('unrepairable')
    expect(result.output).toBeNull()
    expect(typeof result.error?.position).toBe('number')
    expect(result.error?.line).toBe(1)
  })

  test('duplicate keys on valid JSON are reviewable without touching the bytes', () => {
    const input = '{"a":1,"a":2}'
    const result = repair(input)
    expect(result.verdict).toBe('review')
    expect(result.output).toBe(input)
    expect(result.changed).toBe(false)
    expect(result.defects[0].code).toBe('duplicate-key')
  })

  test('minimum severity filters the ledger', () => {
    const result = repair('{"a":NaN}', { minSeverity: 'data' })
    expect(result.ledger.every((e) => e.severity === 'data')).toBe(true)
  })
})

describe('repair: stability', () => {
  test('repairing a repaired document is a no-op', () => {
    for (const input of ['{a:1,}', "{'b':'x'}", '{"c":[1,2,],}']) {
      const first = repair(input)
      const second = repair(first.output as string)
      expect(second.verdict).toBe('ok')
      expect(second.output).toBe(first.output)
    }
  })

  test('the ledger never claims a change for an unchanged document', () => {
    const result = repair('{"a":1}')
    expect(result.counts).toEqual({
      defects: 0,
      fabricated: 0,
      dropped: 0,
      coerced: 0,
      restructured: 0,
      requoted: 0,
      commentsRemoved: 0
    })
  })
})

describe('verify', () => {
  test('identical documents are equal', () => {
    expect(verify('{"a":1}', '{"a":1}')).toEqual({ equal: true, ledger: [], loss: 'none' })
  })

  test('a dropped value is reported', () => {
    const result = verify('{"a":1,"b":2}', '{"a":1}')
    expect(result.equal).toBe(false)
    expect(result.loss).toBe('data')
    expect(result.ledger.some((e) => e.kind === 'dropped' && e.path === '$.b')).toBe(true)
  })

  test('a requoted value is cosmetic', () => {
    const result = verify("{'a':'x'}", '{"a":"x"}')
    expect(result.loss).toBe('cosmetic')
    expect(result.ledger.every((e) => e.severity === 'info')).toBe(true)
  })
})
