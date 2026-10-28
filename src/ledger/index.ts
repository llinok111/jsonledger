/**
 * jsonledger public API.
 *
 * Division of labour:
 *  - jsonrepair decides *how* to fix a document (this layer never rewrites it);
 *  - jsonledger explains what the fix did and whether it is safe to accept.
 */

import { jsonrepair } from '../regular/jsonrepair.js'
import { JSONRepairError } from '../utils/JSONRepairError.js'
import { align } from './align.js'
import { makeLocator, scan } from './scan.js'
import type {
  Defect,
  DefectCode,
  DiagnoseResult,
  LedgerEvent,
  LossLevel,
  RepairCounts,
  RepairOptions,
  RepairResult,
  Verdict
} from './types.js'

export type { DefectSeverity, LedgerKind, LedgerSeverity, ScanResult, ValueToken } from './types.js'
export type {
  Defect,
  DefectCode,
  DiagnoseResult,
  LedgerEvent,
  LossLevel,
  RepairOptions,
  RepairResult,
  Verdict
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

export function diagnose(text: string): DiagnoseResult {
  const source = scan(text)
  const defects = [...source.defects].sort((a, b) => a.start - b.start)
  let validJson = false
  try {
    JSON.parse(stripBom(text))
    validJson = true
  } catch {
    validJson = false
  }
  return { ok: defects.length === 0 && validJson, defects, validJson }
}

function aggregate(defects: Defect[]): LedgerEvent[] {
  const byCode = new Map<DefectCode, Defect[]>()
  for (const d of defects) {
    if (d.severity === 'data') continue
    const list = byCode.get(d.code)
    if (list) list.push(d)
    else byCode.set(d.code, [d])
  }
  const events: LedgerEvent[] = []
  for (const [code, list] of byCode) {
    const first = list[0]
    const count = list.length > 1 ? ` x${list.length}` : ''
    events.push({
      kind: code === 'comment' ? 'comment-removed' : 'structural',
      severity: 'info',
      path: first.path,
      detail:
        code === 'comment'
          ? `removed ${list.length} comment${list.length > 1 ? 's' : ''}`
          : `${first.message}${count}`,
      start: first.start,
      line: first.line,
      column: first.column
    })
  }
  return events
}

function emptyCounts(defects: number): RepairCounts {
  return {
    defects,
    fabricated: 0,
    dropped: 0,
    coerced: 0,
    restructured: 0,
    requoted: 0,
    commentsRemoved: 0
  }
}

export function repair(text: string, options: RepairOptions = {}): RepairResult {
  const policy = options.policy ?? 'report'
  const source = scan(text)
  const defects = [...source.defects].sort((a, b) => a.start - b.start)
  const commentsRemoved = source.commentCount
  let inputValid = false
  try {
    JSON.parse(stripBom(text))
    inputValid = true
  } catch {
    inputValid = false
  }

  let repaired: string
  try {
    repaired = jsonrepair(text)
  } catch (error) {
    const position = error instanceof JSONRepairError ? error.position : undefined
    const locate = makeLocator(text)
    const at = position === undefined ? undefined : locate(position)
    return {
      input: text,
      output: null,
      changed: false,
      defects,
      ledger: [],
      loss: 'data',
      verdict: 'unrepairable',
      counts: emptyCounts(defects.length),
      error: {
        message: error instanceof Error ? error.message : String(error),
        position,
        line: at?.line,
        column: at?.column
      }
    }
  }

  const changed = repaired !== text

  // jsonrepair leaves input untouched when it cannot fix anything. If the input is
  // not valid JSON either, there is nothing usable to hand back.
  if (!changed && !inputValid) {
    return {
      input: text,
      output: null,
      changed: false,
      defects,
      ledger: [],
      loss: 'data',
      verdict: 'unrepairable',
      counts: emptyCounts(defects.length),
      error: { message: 'jsonrepair returned the input unchanged while defects remain' }
    }
  }

  const outputScan = changed ? scan(repaired, { defects: false }) : null
  const aligned = changed && outputScan ? align(source, outputScan) : null
  const findings = aligned?.ledger ?? []
  const counts: RepairCounts = {
    defects: defects.length,
    fabricated: aligned?.counts.fabricated ?? 0,
    dropped: aligned?.counts.dropped ?? 0,
    coerced: aligned?.counts.coerced ?? 0,
    restructured: aligned?.counts.restructured ?? 0,
    requoted: aligned?.counts.requoted ?? 0,
    commentsRemoved
  }

  const cut = defects.filter(
    (d) =>
      d.code === 'unclosed-object' || d.code === 'unclosed-array' || d.code === 'unclosed-string'
  )
  const truncation: LedgerEvent[] = cut.length
    ? [
        {
          kind: 'truncated',
          severity: 'warn',
          path: cut[0].path,
          detail:
            cut.length === 1
              ? `document ends inside ${cut[0].code.replace('unclosed-', '')}; anything after line ${cut[0].line} is unknowable`
              : `document ends inside ${cut.length} unclosed constructs; the tail is unknowable`,
          start: cut[0].start,
          line: cut[0].line,
          column: cut[0].column
        }
      ]
    : []

  // Token alignment cannot see a container that has no scalar inside it, so an empty
  // {} wrapped in [] by the repair would slip through. Counting openings catches it.
  // Skipped for truncated documents, where unbalanced brackets are expected.
  if (outputScan && cut.length === 0) {
    const before = source.containers
    const after = outputScan.containers
    if (before.objects !== after.objects || before.arrays !== after.arrays) {
      counts.restructured++
      findings.push({
        kind: 'restructured',
        severity: 'data',
        path: '$',
        detail: `container count changed: {} ${before.objects}->${after.objects}, [] ${before.arrays}->${after.arrays}`
      })
    }
  }

  const severityOrder = { data: 3, warn: 2, info: 1 } as const
  const ledger = [...findings, ...truncation, ...aggregate(defects)]
    .filter((e) => severityOrder[e.severity] >= severityOrder[options.minSeverity ?? 'info'])
    .sort(
      (a, b) =>
        severityOrder[b.severity] - severityOrder[a.severity] || (a.start ?? 0) - (b.start ?? 0)
    )

  const hasData =
    counts.fabricated > 0 ||
    counts.dropped > 0 ||
    counts.restructured > 0 ||
    findings.some((e) => e.severity === 'data')
  const elided = findings.some((e) => e.kind === 'elided')
  const hasType = findings.some((e) => e.severity === 'warn' && e.kind !== 'elided')

  const loss: LossLevel = !changed
    ? 'none'
    : hasData
      ? 'data'
      : truncation.length > 0 || elided
        ? 'truncated'
        : hasType
          ? 'type'
          : 'cosmetic'
  let verdict: Verdict = !changed
    ? defects.some((d) => d.severity === 'data')
      ? 'review'
      : 'cosmetic'
    : loss === 'data'
      ? 'reject'
      : loss === 'truncated' || loss === 'type'
        ? 'review'
        : 'cosmetic'
  if (verdict === 'cosmetic' && defects.length === 0) verdict = 'ok'

  let output: string | null = repaired
  let refused: string | undefined
  if (policy === 'safe' && verdict === 'reject') {
    output = null
    refused = `refused: repair would ${counts.dropped > 0 ? 'drop' : 'invent'} data (${counts.dropped} dropped, ${counts.fabricated} invented, ${counts.coerced} retyped)`
  }

  return {
    input: text,
    output,
    changed,
    defects,
    ledger,
    loss,
    verdict,
    counts,
    ...(refused ? { refused } : {})
  }
}

/**
 * Compare two documents token by token: `original` may be broken, `repaired` should be valid.
 * Useful to audit a repair produced by another tool (or by a previous run).
 */
export function verify(
  original: string,
  repaired: string
): { equal: boolean; ledger: LedgerEvent[]; loss: LossLevel } {
  if (original === repaired) return { equal: true, ledger: [], loss: 'none' }
  const { ledger } = align(scan(original), scan(repaired, { defects: false }))
  const hasData = ledger.some((e) => e.severity === 'data')
  const elided = ledger.some((e) => e.kind === 'elided')
  const hasType = ledger.some((e) => e.severity === 'warn' && e.kind !== 'elided')
  return {
    equal: false,
    ledger,
    loss: hasData ? 'data' : elided ? 'truncated' : hasType ? 'type' : 'cosmetic'
  }
}
