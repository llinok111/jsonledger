/**
 * Aligns the value tokens of a broken source document against the value tokens of
 * the repaired document.
 *
 * The repair performed by jsonrepair is local (quotes, commas, escapes, inserted
 * closers), so a greedy monotone match with a small lookahead resolves the two
 * token streams reliably: anything that only exists on the output side was
 * invented by the repair, anything that only exists on the source side was
 * dropped by it.
 */

import { looksNumeric } from './scan.js'
import type { LedgerEvent, LedgerSeverity, RepairCounts, ScanResult, ValueToken } from './types.js'

const DEFAULT_LOOKAHEAD = 8

/** `$[2].a` and `$[0].a` have the same shape; `$[2]` and `$[2][0]` do not. */
function shape(path: string): string {
  return path.replace(/\[\d+\]/g, '[]')
}

const SPECIAL_TEXT = new Set(['NaN', 'Infinity', '-Infinity', '+Infinity', 'undefined'])

function sameValue(a: ValueToken, b: ValueToken): boolean {
  if (a.kind === 'number' && b.kind === 'number') return Number(a.raw) === Number(b.raw)
  return a.value === b.value
}

function preview(token: ValueToken): string {
  const raw = token.raw.replace(/\s+/g, ' ')
  return raw.length > 40 ? `${raw.slice(0, 37)}...` : raw
}

function requoteDetail(a: ValueToken, b: ValueToken): string {
  if (a.kind === 'string' && b.kind === 'string') return 'quote style normalised to double quotes'
  return 'bare token quoted as a string'
}

/**
 * Classify a matched (source, output) pair.
 * Returns null when the token survived the repair unchanged.
 */
function classifyPair(
  a: ValueToken,
  b: ValueToken
): Omit<LedgerEvent, 'path' | 'start' | 'line' | 'column'> | null {
  if (a.kind === b.kind) {
    if (a.kind === 'string' && a.quote !== b.quote) {
      return {
        kind: 'requoted',
        severity: 'info',
        detail: requoteDetail(a, b),
        preview: preview(a)
      }
    }
    return null
  }

  if (a.kind === 'special' || (a.kind === 'word' && SPECIAL_TEXT.has(a.value))) {
    return {
      kind: 'coerced',
      severity: 'data',
      detail: `bare ${a.value} is not a JSON value and became a string`,
      preview: preview(b)
    }
  }

  if (b.kind === 'string') {
    if (a.kind === 'word' && looksNumeric(a.value)) {
      return {
        kind: 'coerced',
        severity: 'warn',
        detail: 'invalid number became a string (value shape preserved)',
        preview: preview(b)
      }
    }
    return { kind: 'requoted', severity: 'info', detail: requoteDetail(a, b), preview: preview(a) }
  }

  return {
    kind: 'coerced',
    severity: 'warn',
    detail: `${a.kind} became ${b.kind}`,
    preview: preview(b)
  }
}

function droppedEvent(token: ValueToken, counts: AlignResult['counts']): LedgerEvent {
  // An ellipsis is a marker for members that were never written out: the repair can
  // only delete it, and what it stood for is unknowable rather than lost.
  if (token.kind === 'word' && token.value === '...') {
    return {
      kind: 'elided',
      severity: 'warn',
      path: token.path,
      detail: 'ellipsis placeholder removed; the members it stood for are unknown',
      preview: '...',
      start: token.start
    }
  }
  counts.dropped++
  return {
    kind: 'dropped',
    severity: 'data',
    path: token.path,
    detail: 'value from the source is missing in the repaired document',
    preview: preview(token),
    start: token.start
  }
}

export interface AlignResult {
  ledger: LedgerEvent[]
  counts: Pick<RepairCounts, 'fabricated' | 'dropped' | 'coerced' | 'requoted' | 'restructured'>
}

export function align(
  source: ScanResult,
  output: ScanResult,
  lookahead = DEFAULT_LOOKAHEAD
): AlignResult {
  const src = source.tokens
  const out = output.tokens
  const ledger: LedgerEvent[] = []
  const counts = { fabricated: 0, dropped: 0, coerced: 0, requoted: 0, restructured: 0 }
  let cursor = 0

  const pos = (token: ValueToken) => ({ start: token.start })

  for (let k = 0; k < out.length; k++) {
    const o = out[k]
    let match = -1
    const limit = Math.min(src.length - 1, cursor + lookahead)
    for (let j = cursor; j <= limit; j++) {
      if (sameValue(src[j], o)) {
        match = j
        break
      }
    }

    if (match === -1) {
      counts.fabricated++
      ledger.push({
        kind: 'fabricated',
        severity: 'data',
        path: o.path,
        detail: 'value exists only in the repaired document',
        preview: preview(o)
      })
      continue
    }

    for (let j = cursor; j < match; j++) {
      ledger.push(droppedEvent(src[j], counts))
    }

    // Same value, different nesting: jsonrepair wrapped or unwrapped a container
    // (issue #208 turns [1,2,,3] into [[1,2],3]). Token order alone cannot see this.
    if (shape(src[match].path) !== shape(o.path)) {
      counts.restructured++
      ledger.push({
        kind: 'restructured',
        severity: 'data',
        path: o.path,
        detail: `nesting changed: ${src[match].path} -> ${o.path}`,
        preview: preview(o),
        ...pos(src[match])
      })
    }

    const change = classifyPair(src[match], o)
    if (change) {
      if (change.kind === 'coerced') counts.coerced++
      else counts.requoted++
      ledger.push({ ...change, path: o.path, ...pos(src[match]) })
    }

    cursor = match + 1
  }

  for (let j = cursor; j < src.length; j++) {
    ledger.push(droppedEvent(src[j], counts))
  }

  return { ledger, counts }
}

export function severityRank(s: LedgerSeverity): number {
  return s === 'data' ? 3 : s === 'warn' ? 2 : 1
}
