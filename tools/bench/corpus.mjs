/**
 * Corpus utilities for the jsonledger benchmark.
 *
 * A corruption is applied to a *valid* JSON document, so the expected outcome is
 * known exactly: either the document still means the same thing (cosmetic) or the
 * corruption destroyed/invented information (lossy).
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

export function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function deepEqual(a, b) {
  if (a === b) return true
  if (typeof a !== typeof b) return false
  if (a === null || b === null) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false
    return true
  }
  if (typeof a === 'object') {
    const ka = Object.keys(a)
    const kb = Object.keys(b)
    if (ka.length !== kb.length) return false
    for (const k of ka) {
      if (!Object.hasOwn(b, k)) return false
      if (!deepEqual(a[k], b[k])) return false
    }
    return true
  }
  return false
}

/**
 * Serialise a value in a deliberately relaxed dialect.
 * Every option maps to one corruption class of the benchmark.
 */
export function loose(value, options = {}, depth = 0) {
  const q = options.quote ?? '"'
  const pad = options.pretty ? '  '.repeat(depth) : ''
  const inner = options.pretty ? `\n${'  '.repeat(depth + 1)}` : ''
  const nl = options.pretty ? `\n${pad}` : ''
  const colon = options.pretty ? ': ' : options.colonSpace ? ': ' : ':'
  const comma = options.pretty ? ',' : options.commaSpace ? ', ' : ','

  const str = (s) => {
    const body = s
      .replace(/\\/g, '\\\\')
      .replace(new RegExp(q === '"' ? '"' : q, 'g'), `\\${q}`)
      .replace(/\n/g, '\\n')
      .replace(/\r/g, '\\r')
      .replace(/\t/g, '\\t')
    return `${q}${body}${q}`
  }

  const key = (k) => {
    if (options.unquotedKeys && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k)) return k
    return str(k)
  }

  const note = () =>
    options.comments && options.rand && options.rand() < 0.25 ? ' /* note */' : ''

  if (value === null) return 'null'
  if (value === undefined) return options.allowSpecial ? 'undefined' : 'null'
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      if (!options.allowSpecial) return 'null'
      return Number.isNaN(value) ? 'NaN' : value > 0 ? 'Infinity' : '-Infinity'
    }
    return String(value)
  }
  if (typeof value === 'boolean') return String(value)
  if (typeof value === 'string') return str(value)

  if (Array.isArray(value)) {
    if (value.length === 0) return '[]'
    const parts = value.map((v) => inner + loose(v, options, depth + 1) + note())
    if (options.trailingCommas) parts.push(`${inner.slice(0, -1)} `)
    return `[${parts.join(comma)}${nl}]`
  }

  const entries = Object.entries(value)
  if (entries.length === 0) return '{}'
  const parts = entries.map(
    ([k, v]) => inner + key(k) + colon + loose(v, options, depth + 1) + note()
  )
  if (options.trailingCommas && !options.comments) parts.push(`${inner.slice(0, -1)} `)
  return `{${parts.join(comma)}${nl}}`
}

/** Corruptions that keep the meaning of the document intact. */
export const COSMETIC_CLASSES = [
  'trailing-comma',
  'single-quote',
  'unquoted-keys',
  'comments',
  'bom',
  'messy'
]

/** Corruptions that destroy or invent information. */
export const LOSSY_CLASSES = ['truncate', 'special-literal', 'ellipsis', 'double-comma']

/** Insert a second comma at the first array separator (jsonrepair issue #208). */
function duplicateArrayComma(text) {
  const stack = []
  let inString = false
  let escaped = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (c === '\\') escaped = true
      else if (c === '"') inString = false
      continue
    }
    if (c === '"') inString = true
    else if (c === '{' || c === '[') stack.push(c)
    else if (c === '}' || c === ']') stack.pop()
    else if (c === ',' && stack[stack.length - 1] === '[')
      return `${text.slice(0, i)},${text.slice(i)}`
  }
  return null
}

export function corrupt(text, value, cls, rand) {
  switch (cls) {
    case 'trailing-comma':
      return loose(value, { trailingCommas: true, commaSpace: true })
    case 'single-quote':
      return loose(value, { quote: "'", commaSpace: true })
    case 'unquoted-keys':
      return loose(value, { unquotedKeys: true })
    case 'comments':
      return loose(value, { comments: true, rand, commaSpace: true })
    case 'bom':
      return `\ufeff${text}`
    case 'messy':
      return loose(value, {
        quote: "'",
        unquotedKeys: true,
        trailingCommas: true,
        comments: true,
        rand,
        commaSpace: true
      })
    case 'truncate': {
      if (text.length < 40) return null
      const cut = Math.floor(text.length * (0.55 + rand() * 0.3))
      return text.slice(0, cut)
    }
    case 'special-literal': {
      // JSON.parse can never yield NaN/Infinity, so inject one into a random leaf.
      const paths = []
      const collect = (v, trail) => {
        if (v && typeof v === 'object') {
          for (const [k, child] of Object.entries(v)) collect(child, [...trail, k])
        } else if (trail.length) paths.push(trail)
      }
      collect(value, [])
      if (paths.length === 0) return null
      const target = paths[Math.floor(rand() * paths.length)]
      const clone = structuredClone(value)
      let node = clone
      for (let i = 0; i < target.length - 1; i++) node = node[target[i]]
      node[target[target.length - 1]] = rand() < 0.5 ? Number.NaN : Number.POSITIVE_INFINITY
      return loose(clone, { allowSpecial: true, commaSpace: true })
    }
    case 'double-comma': {
      const doubled = duplicateArrayComma(text)
      return doubled === text ? null : doubled
    }
    case 'ellipsis': {
      if (text.length < 20) return null
      const idx = text.lastIndexOf('}')
      if (idx < 0) return null
      return `${text.slice(0, idx)}, ...${text.slice(idx)}`
    }
    default:
      throw new Error(`unknown corruption class ${cls}`)
  }
}

export function* walkJsonFiles(root, options = {}) {
  const maxSize = options.maxSize ?? 60_000
  const maxDepth = options.maxDepth ?? 8
  function* walk(dir, depth) {
    if (depth > maxDepth) return
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name === '.git') continue
      const path = join(dir, entry.name)
      if (entry.isDirectory()) yield* walk(path, depth + 1)
      else if (entry.isFile() && entry.name.endsWith('.json') && !entry.name.endsWith('.map')) {
        try {
          if (statSync(path).size > maxSize) continue
        } catch {
          continue
        }
        yield path
      }
    }
  }
  yield* walk(root, 0)
}

export function loadCorpus(roots, options = {}) {
  const seen = new Set()
  const docs = []
  for (const root of roots) {
    for (const path of walkJsonFiles(root, options)) {
      let text
      try {
        text = readFileSync(path, 'utf8')
      } catch {
        continue
      }
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
      let value
      try {
        value = JSON.parse(text)
      } catch {
        continue
      }
      if (seen.has(text)) continue
      seen.add(text)
      docs.push({ path, text, value })
      if (options.limit && docs.length >= options.limit) return docs
    }
  }
  return docs
}
