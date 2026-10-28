/**
 * Tolerant scanner for (possibly broken) JSON text.
 *
 * This is NOT a parser and NOT a repair engine. It produces two things:
 *  - a flat list of value bearing tokens (keys and scalar values) with offsets,
 *    used to align source text against repaired text;
 *  - a list of defects with positions, used to explain *why* a document is broken.
 *
 * Structural containers are tracked on a stack so every token can carry a JSON
 * path. Containers themselves are not emitted as tokens, which means an invented
 * empty container cannot be attributed by the ledger (documented limitation).
 */

import type {
  Defect,
  DefectCode,
  DefectSeverity,
  ScanResult,
  TokenKind,
  ValueToken
} from './types.js'

const SEVERITY: Record<DefectCode, DefectSeverity> = {
  bom: 'cosmetic',
  comment: 'cosmetic',
  'markdown-fence': 'cosmetic',
  'single-quote': 'syntax',
  'smart-quote': 'syntax',
  'unquoted-key': 'syntax',
  'trailing-comma': 'syntax',
  'double-comma': 'syntax',
  'missing-comma': 'syntax',
  'missing-colon': 'syntax',
  'unexpected-colon': 'syntax',
  'raw-newline-in-string': 'syntax',
  'raw-control-char': 'syntax',
  'unquoted-value': 'data',
  'non-standard-literal': 'data',
  'invalid-number': 'data',
  'missing-value': 'data',
  'unexpected-closer': 'data',
  'unclosed-string': 'data',
  'unclosed-object': 'data',
  'unclosed-array': 'data',
  ellipsis: 'data',
  'duplicate-key': 'data',
  'empty-document': 'data'
}

const MESSAGE: Record<DefectCode, string> = {
  bom: 'byte order mark before the document',
  comment: 'comment outside of a string',
  'markdown-fence': 'markdown code fence around the document',
  'single-quote': 'string delimited by single quotes',
  'smart-quote': 'string delimited by typographic quotes',
  'unquoted-key': 'object key is not quoted',
  'trailing-comma': 'comma before a closing bracket',
  'double-comma': 'two commas in a row',
  'missing-comma': 'two members without a comma between them',
  'missing-colon': 'object key without a colon',
  'unexpected-colon': 'colon outside an object member',
  'raw-newline-in-string': 'unescaped newline inside a string',
  'raw-control-char': 'unescaped control character inside a string',
  'unquoted-value': 'bare word where a value is expected',
  'non-standard-literal': 'non standard literal (NaN, Infinity, undefined)',
  'invalid-number': 'token that looks numeric but is not a valid JSON number',
  'missing-value': 'comma or colon without a value',
  'unexpected-closer': 'closing bracket without a matching opener',
  'unclosed-string': 'string is never closed',
  'unclosed-object': 'object is never closed',
  'unclosed-array': 'array is never closed',
  ellipsis: 'ellipsis placeholder instead of members',
  'duplicate-key': 'duplicate object key',
  'empty-document': 'no JSON value found'
}

const NUMBER_RE = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?$/
const SPECIALS = new Set(['NaN', 'Infinity', '-Infinity', '+Infinity', 'undefined'])
const LITERALS = new Set(['true', 'false', 'null'])
const IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/

interface Frame {
  type: '{' | '['
  start: number
  path: string
  parent: Frame | null
  segment: string
  index: number
  keys: Set<string>
  expect: 'key' | 'colon' | 'value' | 'comma'
}

export type Locator = (offset: number) => { line: number; column: number }

export function makeLocator(text: string): Locator {
  const starts = [0]
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) starts.push(i + 1)
  }
  return (offset: number) => {
    let lo = 0
    let hi = starts.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (starts[mid] <= offset) lo = mid
      else hi = mid - 1
    }
    return { line: lo + 1, column: offset - starts[lo] + 1 }
  }
}

function joinKey(base: string, key: string): string {
  return IDENT_RE.test(key) ? `${base}.${key}` : `${base}[${JSON.stringify(key)}]`
}

function isDelimiter(c: string): boolean {
  return (
    c === ' ' ||
    c === '\t' ||
    c === '\n' ||
    c === '\r' ||
    c === '{' ||
    c === '}' ||
    c === '[' ||
    c === ']' ||
    c === ':' ||
    c === ',' ||
    c === '"' ||
    c === "'" ||
    c === '\u201c' ||
    c === '\u201d' ||
    c === '\u2018' ||
    c === '\u2019' ||
    c === '`'
  )
}

function classify(raw: string): TokenKind {
  if (NUMBER_RE.test(raw)) return 'number'
  if (LITERALS.has(raw)) return 'literal'
  if (SPECIALS.has(raw)) return 'special'
  return 'word'
}

/**
 * True for tokens that a human would read as a number but JSON cannot express:
 * `0.0.1`, `2020-01-01`, `1.2.3`. A bare URL or a bare word must not match.
 */
export function looksNumeric(raw: string): boolean {
  return /^[+-]?[0-9]/.test(raw) && /[.:\-/+]/.test(raw)
}

export interface ScanOptions {
  /** Set to false to skip defect collection (used when scanning repaired output). */
  defects?: boolean
}

export function scan(text: string, options: ScanOptions = {}): ScanResult {
  const collectDefects = options.defects !== false
  const locate = makeLocator(text)
  const tokens: ValueToken[] = []
  const defects: Defect[] = []
  const frames: Frame[] = []
  let commentCount = 0
  const containers = { objects: 0, arrays: 0 }
  let i = 0

  const top = (): Frame | undefined => frames[frames.length - 1]

  const currentPath = (): string => {
    const f = top()
    if (!f) return '$'
    return f.type === '{' ? joinKey(f.path, f.segment) : `${f.path}[${f.index}]`
  }

  const slotPath = (): string => {
    const f = top()
    if (!f) return '$'
    if (f.type === '{') return f.expect === 'key' ? f.path : joinKey(f.path, f.segment)
    return `${f.path}[${f.index}]`
  }

  const report = (code: DefectCode, start: number, end: number, path?: string): void => {
    if (!collectDefects) return
    const pos = locate(start)
    defects.push({
      code,
      severity: SEVERITY[code],
      start,
      end: Math.max(end, start),
      line: pos.line,
      column: pos.column,
      message: MESSAGE[code],
      path: path ?? currentPath()
    })
  }

  const reportValueDefects = (t: Omit<ValueToken, 'path' | 'isKey'>, path: string): void => {
    if (t.kind === 'word') {
      if (t.value === '...') report('ellipsis', t.start, t.end, path)
      else if (looksNumeric(t.value)) report('invalid-number', t.start, t.end, path)
      else report('unquoted-value', t.start, t.end, path)
    } else if (t.kind === 'special') {
      report('non-standard-literal', t.start, t.end, path)
    }
  }

  const pushToken = (t: Omit<ValueToken, 'path' | 'isKey'>): void => {
    const f = top()
    let isKey = false
    let path: string

    if (!f) {
      path = '$'
      reportValueDefects(t, path)
    } else if (f.type === '{') {
      if (f.expect === 'key' || f.expect === 'comma') {
        if (f.expect === 'comma') report('missing-comma', t.start, t.end, f.path)
        isKey = true
        path = joinKey(f.path, t.value)
        if (f.keys.has(t.value)) report('duplicate-key', t.start, t.end, path)
        f.keys.add(t.value)
        f.segment = t.value
        f.expect = 'colon'
        if (t.kind === 'word' && t.value === '...') report('ellipsis', t.start, t.end, path)
        else if (t.kind !== 'string') report('unquoted-key', t.start, t.end, path)
      } else {
        path = joinKey(f.path, f.segment)
        if (f.expect === 'colon') report('missing-colon', t.start, t.end, path)
        f.expect = 'comma'
        reportValueDefects(t, path)
      }
    } else {
      path = `${f.path}[${f.index}]`
      if (f.expect === 'comma') report('missing-comma', t.start, t.end, path)
      f.index++
      f.expect = 'comma'
      reportValueDefects(t, path)
    }

    tokens.push({ ...t, path, isKey })
  }

  if (text.charCodeAt(0) === 0xfeff) {
    report('bom', 0, 1, '$')
    i = 1
  }

  const skipFence = (): boolean => {
    let j = i
    while (j < text.length && (text[j] === ' ' || text[j] === '\t')) j++
    if (!text.startsWith('```', j)) return false
    const eol = text.indexOf('\n', j)
    const end = eol === -1 ? text.length : eol
    report('markdown-fence', j, end, '$')
    i = end === text.length ? end : end + 1
    return true
  }
  skipFence()

  while (i < text.length) {
    const c = text[i]

    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i++
      continue
    }

    if (c === '/' && text[i + 1] === '/') {
      commentCount++
      let end = text.indexOf('\n', i)
      if (end === -1) end = text.length
      report('comment', i, end)
      i = end
      continue
    }

    if (c === '/' && text[i + 1] === '*') {
      commentCount++
      const close = text.indexOf('*/', i + 2)
      const end = close === -1 ? text.length : close + 2
      report('comment', i, end)
      i = end
      continue
    }

    if (c === '`' && text.startsWith('```', i)) {
      const eol = text.indexOf('\n', i)
      const end = eol === -1 ? text.length : eol
      report('markdown-fence', i, end, '$')
      i = end === text.length ? end : end + 1
      continue
    }

    if (c === '{' || c === '[') {
      const parent = top()
      if (parent) {
        if (parent.expect === 'colon') report('missing-colon', i, i + 1)
        else if (parent.expect === 'comma') report('missing-comma', i, i + 1)
      }
      const path = slotPath()
      frames.push({
        type: c === '{' ? '{' : '[',
        start: i,
        path,
        parent: parent ?? null,
        segment: '',
        index: 0,
        keys: new Set(),
        expect: c === '{' ? 'key' : 'value'
      })
      if (parent) parent.expect = 'comma'
      if (c === '{') containers.objects++
      else containers.arrays++
      i++
      continue
    }

    if (c === '}' || c === ']') {
      const want = c === '}' ? '{' : '['
      const f = top()
      if (!f) {
        report('unexpected-closer', i, i + 1, '$')
        i++
        continue
      }
      if (f.type !== want) report('unexpected-closer', i, i + 1, f.path)
      else if (f.expect === 'colon') report('missing-colon', i, i + 1, f.path)
      // An empty array is valid, so a missing value only exists in an object:
      // {"a":} has no value, [] simply has no elements.
      else if (f.expect === 'value' && f.type === '{') report('missing-value', i, i + 1, f.path)
      frames.pop()
      // An array counts elements, not scalars: close the slot for this container too.
      if (f.parent && f.parent.type === '[') f.parent.index++
      i++
      continue
    }

    if (c === ',') {
      const f = top()
      if (!f) {
        report('unexpected-closer', i, i + 1, '$')
        i++
        continue
      }
      let j = i + 1
      while (j < text.length && ' \t\n\r'.includes(text[j])) j++
      const next = text[j]
      if (next === '}' || next === ']') {
        // A trailing comma is one defect, not a trailing comma plus a missing value.
        report('trailing-comma', i, i + 1, f.path)
        f.expect = 'comma'
        i++
        continue
      }
      if (f.expect === 'key') report('double-comma', i, i + 1, f.path)
      else if (f.expect === 'value') report('missing-value', i, i + 1, f.path)
      f.expect = f.type === '{' ? 'key' : 'value'
      i++
      continue
    }

    if (c === ':') {
      const f = top()
      if (f && f.type === '{' && f.expect === 'colon') f.expect = 'value'
      else report('unexpected-colon', i, i + 1)
      i++
      continue
    }

    if (c === '"' || c === "'" || c === '\u201c' || c === '\u2018') {
      const close = c === '\u201c' ? '\u201d' : c === '\u2018' ? '\u2019' : c
      const start = i
      let j = i + 1
      let value = ''
      let closed = false
      let rawNewline = -1
      let rawControl = -1
      while (j < text.length) {
        const ch = text[j]
        if (ch === '\\') {
          const n = text[j + 1]
          if (n === undefined) {
            j++
            break
          }
          if (n === 'u' && /^[0-9a-fA-F]{4}$/.test(text.slice(j + 2, j + 6))) {
            value += String.fromCharCode(Number.parseInt(text.slice(j + 2, j + 6), 16))
            j += 6
            continue
          }
          const map: Record<string, string> = {
            n: '\n',
            t: '\t',
            r: '\r',
            b: '\b',
            f: '\f',
            '"': '"',
            "'": "'",
            '/': '/',
            '\\': '\\'
          }
          value += map[n] ?? n
          j += 2
          continue
        }
        // A typographic quote may be closed by a plain double quote; a single quoted
        // string must not be closed by " (values like 'he said "hi"' are common).
        if (ch === close || (close !== '"' && close !== "'" && ch === '"')) {
          closed = true
          j++
          break
        }
        if (ch === '\n' && rawNewline === -1) rawNewline = j - 1
        if (ch < ' ' && rawControl === -1 && ch !== '\t') rawControl = j - 1
        value += ch
        j++
      }
      const end = j
      const path = slotPath()
      if (!closed) report('unclosed-string', start, end, path)
      else if (rawNewline !== -1) report('raw-newline-in-string', rawNewline, rawNewline + 1, path)
      else if (rawControl !== -1) report('raw-control-char', rawControl, rawControl + 1, path)
      if (c === "'") report('single-quote', start, start + 1, path)
      if (c === '\u201c' || c === '\u2018') report('smart-quote', start, start + 1, path)
      pushToken({
        kind: 'string',
        raw: text.slice(start, end),
        value,
        start,
        end,
        quote: c,
        closed
      })
      i = end
      continue
    }

    {
      const start = i
      let j = i
      // A colon can only end a key; anywhere else it is part of a bare token
      // (C:\temp, https://host/path, 12:30). Keeping such tokens in one piece is
      // what jsonrepair does too, so the ledger does not invent drops for them.
      const colonEndsToken = (): boolean => {
        const f = top()
        return !!f && f.type === '{' && (f.expect === 'key' || f.expect === 'colon')
      }
      while (j < text.length) {
        const ch = text[j]
        if (!isDelimiter(ch)) {
          j++
          continue
        }
        if (ch === ':' && !colonEndsToken()) {
          j++
          continue
        }
        break
      }
      if (j === i) {
        i++
        continue
      }
      const raw = text.slice(start, j)
      pushToken({ kind: classify(raw), raw, value: raw, start, end: j, closed: true })
      i = j
    }
  }

  // Innermost first: that is the order a human would fix them in.
  for (const f of [...frames].reverse()) {
    report(f.type === '{' ? 'unclosed-object' : 'unclosed-array', f.start, f.start + 1, f.path)
  }

  if (tokens.length === 0 && defects.length === 0) {
    report('empty-document', 0, text.length, '$')
  }

  return { tokens, defects, commentCount, containers }
}
