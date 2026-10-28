import type { Defect, RepairResult } from './types.js'

const LABEL: Record<string, string> = {
  fabricated: 'invented',
  restructured: 'nesting',
  dropped: 'dropped',
  coerced: 'retyped',
  requoted: 'requoted',
  truncated: 'truncated',
  structural: 'structure',
  'comment-removed': 'comments'
}

function size(n: number): string {
  return `${n} B`
}

/** Human readable report for one repair result. Used by the CLI and handy in CI logs. */
export function formatReport(
  result: RepairResult,
  options: { showDefects?: boolean } = {}
): string {
  const lines: string[] = []
  const { counts } = result
  lines.push(`verdict: ${result.verdict}   loss: ${result.loss}`)
  lines.push(
    `source: ${size(result.input.length)}  ->  ${result.changed ? size((result.output ?? '').length) : 'unchanged'}`
  )
  lines.push(
    `defects: ${counts.defects}   invented: ${counts.fabricated}   dropped: ${counts.dropped}   retyped: ${counts.coerced}   nesting: ${counts.restructured}   comments removed: ${counts.commentsRemoved}`
  )
  if (result.refused) lines.push(`refused: ${result.refused}`)
  if (result.error) {
    const where = result.error.line ? ` at line ${result.error.line}:${result.error.column}` : ''
    lines.push(`error: ${result.error.message}${where}`)
  }

  if (result.ledger.length) {
    lines.push('')
    for (const event of result.ledger) {
      const where = event.line ? `line ${event.line}:${event.column}` : '       '
      const label = LABEL[event.kind] ?? event.kind
      const preview = event.preview ? `  ${event.preview}` : ''
      lines.push(
        `  ${event.severity.toUpperCase().padEnd(4)} ${where.padEnd(16)} ${label.padEnd(9)} ${event.path}${preview}`
      )
      lines.push(`       ${' '.repeat(16)} ${event.detail}`)
    }
  }

  if (options.showDefects !== false && result.defects.length) {
    lines.push('')
    lines.push('defects (source order)')
    for (const d of result.defects) {
      lines.push(
        `  line ${d.line}:${d.column}  ${d.code.padEnd(22)} ${d.severity.padEnd(8)} ${d.path}`
      )
    }
  }

  return `${lines.join('\n')}\n`
}

export function formatDefects(file: string, defects: Defect[]): string {
  if (defects.length === 0) return `${file}: clean\n`
  const lines = [`${file}: ${defects.length} defect${defects.length > 1 ? 's' : ''}`]
  for (const d of defects) {
    lines.push(
      `  line ${d.line}:${d.column}  ${d.code.padEnd(22)} ${d.severity.padEnd(8)} ${d.message}`
    )
  }
  return `${lines.join('\n')}\n`
}
