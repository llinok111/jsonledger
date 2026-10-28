/**
 * Public types for the jsonledger evidence layer.
 *
 * jsonledger does not repair JSON itself: all repair work is delegated to
 * `jsonrepair`. This module only describes *what a repair did*.
 */

export type DefectCode =
  | 'bom'
  | 'comment'
  | 'single-quote'
  | 'smart-quote'
  | 'unquoted-key'
  | 'unquoted-value'
  | 'non-standard-literal'
  | 'invalid-number'
  | 'trailing-comma'
  | 'double-comma'
  | 'missing-comma'
  | 'missing-value'
  | 'missing-colon'
  | 'unexpected-colon'
  | 'unexpected-closer'
  | 'unclosed-string'
  | 'unclosed-object'
  | 'unclosed-array'
  | 'raw-control-char'
  | 'raw-newline-in-string'
  | 'ellipsis'
  | 'markdown-fence'
  | 'duplicate-key'
  | 'empty-document'

/** How risky it is to let a repair resolve this defect. */
export type DefectSeverity = 'cosmetic' | 'syntax' | 'data'

export interface Defect {
  code: DefectCode
  severity: DefectSeverity
  /** Offset of the first character of the defect in the source text. */
  start: number
  end: number
  line: number
  column: number
  message: string
  /** JSON path of the enclosing node, best effort (source may be malformed). */
  path: string
}

export type TokenKind = 'string' | 'number' | 'literal' | 'special' | 'word'

export interface ValueToken {
  kind: TokenKind
  /** Exact source slice. */
  raw: string
  /** Decoded text for strings, trimmed raw for numbers/literals/words. */
  value: string
  start: number
  end: number
  /** Quote character used by the source, when kind === 'string'. */
  quote?: string
  /** False when the string literal was never closed. */
  closed: boolean
  /** JSON path of this token, best effort. */
  path: string
  /** True when the token is an object key rather than a value. */
  isKey: boolean
}

export interface ScanResult {
  tokens: ValueToken[]
  defects: Defect[]
  commentCount: number
  /** Number of container opening brackets seen, by type. */
  containers: { objects: number; arrays: number }
}

export type LedgerKind =
  | 'fabricated'
  | 'dropped'
  | 'coerced'
  | 'elided'
  | 'restructured'
  | 'requoted'
  | 'escaped'
  | 'truncated'
  | 'structural'
  | 'comment-removed'

export type LedgerSeverity = 'info' | 'warn' | 'data'

export interface LedgerEvent {
  kind: LedgerKind
  severity: LedgerSeverity
  /** JSON path in the repaired document (or in the source, for drops). */
  path: string
  detail: string
  /** Offset in the source text, when the event can be located there. */
  start?: number
  line?: number
  column?: number
  /** Human readable value preview. */
  preview?: string
}

/**
 * Ordered from least to most destructive.
 * `truncated` means the document ended inside a container or string: the repair
 * closes it, but whatever used to follow the cut is unknowable.
 */
export type LossLevel = 'none' | 'cosmetic' | 'type' | 'truncated' | 'data'

export type Verdict = 'ok' | 'cosmetic' | 'review' | 'reject' | 'unrepairable'

export interface RepairCounts {
  defects: number
  fabricated: number
  dropped: number
  coerced: number
  restructured: number
  requoted: number
  commentsRemoved: number
}

export interface RepairResult {
  input: string
  /** Repaired text, or null when the result must not be used. */
  output: string | null
  changed: boolean
  defects: Defect[]
  ledger: LedgerEvent[]
  loss: LossLevel
  verdict: Verdict
  counts: RepairCounts
  /** Present when jsonrepair threw. */
  error?: { message: string; position?: number; line?: number; column?: number }
  /** Present when the requested policy refused to hand back an output. */
  refused?: string
}

export interface DiagnoseResult {
  ok: boolean
  defects: Defect[]
  /** True when the text parses with JSON.parse after stripping a BOM. */
  validJson: boolean
}

export interface RepairOptions {
  /** 'report' (default) always returns an output; 'safe' withholds lossy output. */
  policy?: 'report' | 'safe'
  /** Return the ledger only for these severities. */
  minSeverity?: LedgerSeverity
}
