import { describe, expect, test } from 'vitest'
import { diagnose } from './index.js'
import { scan } from './scan.js'

const codes = (text: string) => scan(text).defects.map((d) => d.code)

describe('scanner: defect classes', () => {
  test('byte order mark', () => {
    expect(codes('\ufeff{"a":1}')).toEqual(['bom'])
  })

  test('line and block comments', () => {
    expect(codes('{"a":1 // note\n}')).toEqual(['comment'])
    expect(codes('{"a":/* x */1}')).toEqual(['comment'])
  })

  test('single quotes and typographic quotes', () => {
    expect(codes("{'a':1}")).toEqual(['single-quote'])
    expect(codes('{\u201ca\u201d:1}')).toEqual(['smart-quote'])
  })

  test('unquoted keys versus unquoted values', () => {
    expect(codes('{a:1}')).toEqual(['unquoted-key'])
    const value = scan('{"a":hello}')
    expect(value.defects.map((d) => d.code)).toEqual(['unquoted-value'])
    expect(value.defects[0].severity).toBe('data')
  })

  test('trailing comma, double comma, missing comma, missing colon', () => {
    expect(codes('{"a":1,}')).toEqual(['trailing-comma'])
    expect(codes('[1,2,]')).toEqual(['trailing-comma'])
    expect(codes('{"a":1,,"b":2}')).toEqual(['double-comma'])
    expect(codes('{"a":1 "b":2}')).toEqual(['missing-comma'])
    expect(codes('{"a" 1}')).toEqual(['missing-colon'])
  })

  test('missing value and unexpected closer', () => {
    expect(codes('[1,,2]')).toEqual(['missing-value'])
    expect(codes('{"a":}')).toEqual(['missing-value'])
    expect(codes('{"a":1}}')).toEqual(['unexpected-closer'])
  })

  test('empty containers are valid and never reported as missing values', () => {
    // Regression: an empty [] used to be flagged as a missing value, which made
    // 11 of 600 real package manifests look broken.
    expect(codes('{"a":[]}')).toEqual([])
    expect(codes('{"a":{}}')).toEqual([])
    expect(codes('[[],[{}],{"b":[]}]')).toEqual([])
  })

  test('unterminated constructs are reported where they start', () => {
    const result = scan('{\n  "a": [1, 2\n')
    const found = result.defects.map((d) => `${d.code}@${d.line}:${d.column}`)
    expect(found).toEqual(['unclosed-array@2:8', 'unclosed-object@1:1'])
  })

  test('non standard literals and invalid numbers', () => {
    expect(codes('{"a":NaN}')).toEqual(['non-standard-literal'])
    expect(codes('{"a":undefined}')).toEqual(['non-standard-literal'])
    expect(codes('{"v":0.0.1}')).toEqual(['invalid-number'])
    expect(codes('{"v":2020-01-01}')).toEqual(['invalid-number'])
  })

  test('ellipsis, markdown fence and duplicate keys', () => {
    expect(codes('{"a":1, ...}')).toEqual(['ellipsis', 'missing-colon'])
    expect(codes('```json\n{"a":1}\n```')).toEqual(['markdown-fence', 'markdown-fence'])
    expect(codes('{"a":1,"a":2}')).toEqual(['duplicate-key'])
  })

  test('an empty document is a defect of its own', () => {
    expect(codes('   ')).toEqual(['empty-document'])
    expect(codes('')).toEqual(['empty-document'])
  })
})

describe('scanner: positions and paths', () => {
  test('positions point at the offending character', () => {
    const { defects } = scan('{\n  "a": 1,\n}')
    expect(defects).toHaveLength(1)
    expect(defects[0].code).toBe('trailing-comma')
    expect(defects[0].line).toBe(2)
    expect(defects[0].column).toBe(9)
  })

  test('paths follow arrays and nested objects', () => {
    const { tokens } = scan('[{"id":1},{"id":2}]')
    expect(tokens.map((t) => t.path)).toEqual(['$[0].id', '$[0].id', '$[1].id', '$[1].id'])
    expect(tokens.filter((t) => t.isKey)).toHaveLength(2)
  })

  test('quoted keys that are not identifiers use bracket notation', () => {
    const { tokens } = scan('{"a b":1}')
    expect(tokens[0].path).toBe('$["a b"]')
  })
})

describe('scanner: values that contain delimiters', () => {
  test('a colon inside a bare value does not split the token', () => {
    const { tokens, defects } = scan('{"u":https://example.com/a?b=1}')
    expect(tokens.map((t) => t.value)).toEqual(['u', 'https://example.com/a?b=1'])
    expect(defects.map((d) => d.code)).toEqual(['unquoted-value'])
  })

  test('a windows path stays in one piece', () => {
    const { tokens } = scan('{"p":C:\\temp\\x}')
    expect(tokens[1].value).toBe('C:\\temp\\x')
  })

  test('a colon after a key still ends the token', () => {
    const { tokens } = scan('{a:1}')
    expect(tokens[0].value).toBe('a')
    expect(tokens[0].isKey).toBe(true)
  })

  test('a single quoted string may contain a double quote', () => {
    const { tokens, defects } = scan("{'a':'he said \"hi\"'}")
    expect(tokens.filter((t) => t.kind === 'string').map((t) => t.value)).toEqual([
      'a',
      'he said "hi"'
    ])
    expect(defects.map((d) => d.code)).toEqual(['single-quote', 'single-quote'])
  })

  test('escapes are decoded so both spellings compare equal', () => {
    const { tokens } = scan('{"a":"\\u00e9\\n\\"x\\""}')
    expect(tokens[1].value).toBe('\u00e9\n"x"')
  })
})

describe('diagnose', () => {
  test('valid JSON is clean', () => {
    const result = diagnose('{"a":[1,2,{"b":null}]}')
    expect(result.ok).toBe(true)
    expect(result.validJson).toBe(true)
    expect(result.defects).toEqual([])
  })

  test('a BOM alone does not make the document invalid', () => {
    const result = diagnose('\ufeff{"a":1}')
    expect(result.validJson).toBe(true)
    expect(result.ok).toBe(false)
    expect(result.defects.map((d) => d.code)).toEqual(['bom'])
  })

  test('duplicate keys parse but are reported', () => {
    const result = diagnose('{"a":1,"a":2}')
    expect(result.validJson).toBe(true)
    expect(result.ok).toBe(false)
    expect(result.defects[0].code).toBe('duplicate-key')
    expect(result.defects[0].path).toBe('$.a')
  })

  test('defects come back in source order', () => {
    const result = diagnose('{a:1, b:2,}')
    expect(result.defects.map((d) => d.start)).toEqual(
      [...result.defects.map((d) => d.start)].sort((x, y) => x - y)
    )
  })
})
