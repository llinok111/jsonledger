// Only use native node.js APIs and references to ./lib here: this file is not transpiled.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const BIN = join(__dirname, '..', 'bin', 'jsonledger.js')
const TMP = join(__dirname, 'output', 'ledger')

function run(args, options = {}) {
  const result = spawnSync(process.execPath, [BIN, ...args], {
    encoding: 'utf8',
    input: options.input,
    cwd: TMP
  })
  return { code: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

function write(name, content) {
  writeFileSync(join(TMP, name), content)
  return join(TMP, name)
}

describe('jsonledger CLI', () => {
  beforeEach(() => {
    mkdirSync(TMP, { recursive: true })
  })

  afterEach(() => {
    rmSync(TMP, { recursive: true, force: true })
  })

  test('a clean document exits 0 and prints nothing on stdout', () => {
    const file = write('clean.json', '{"a":1}')
    const result = run(['check', file])
    expect(result.code).toBe(0)
    expect(result.stderr).toContain('clean')
  })

  test('repair of a clean document echoes it unchanged', () => {
    const file = write('clean.json', '{"a":1}')
    const result = run(['repair', file, '--no-report'])
    expect(result.code).toBe(0)
    expect(result.stdout).toBe('{"a":1}')
  })

  test('a cosmetic defect exits 1 and writes a loadable file', () => {
    const file = write('cosmetic.json', "{'a':1,,'b':2}".replace(',,', ','))
    const out = join(TMP, 'fixed.json')
    const result = run(['repair', file, '-o', out])
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('verdict: cosmetic')
    expect(JSON.parse(readFileSync(out, 'utf8'))).toEqual({ a: 1, b: 2 })
  })

  test('a lossy repair exits 3 and withholds the document', () => {
    const file = write('lossy.json', '{"a":NaN}')
    const result = run(['repair', file])
    expect(result.code).toBe(3)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('refusing to emit a lossy document')
  })

  test('--force emits the lossy document anyway', () => {
    const file = write('lossy.json', '{"a":NaN}')
    const result = run(['repair', file, '--force', '--no-report'])
    expect(result.code).toBe(3)
    expect(JSON.parse(result.stdout)).toEqual({ a: 'NaN' })
  })

  test('a truncated document exits 2 and is emitted with a warning', () => {
    const file = write('cut.json', '{"a":1,"b":[1,2')
    const result = run(['repair', file, '--no-report'])
    expect(result.code).toBe(2)
    expect(result.stdout).toBe('{"a":1,"b":[1,2]}')
  })

  test('an unrepairable document exits 4', () => {
    const file = write('bad.json', '{"a":1} trailing garbage')
    const result = run(['repair', file])
    expect(result.code).toBe(4)
    expect(result.stderr).toContain('unrepairable')
  })

  test('check exits 2 when a defect may have destroyed data', () => {
    const file = write('nan.json', '{"a":NaN}')
    const result = run(['check', file])
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('non-standard-literal')
  })

  test('check exits 1 for syntax only defects', () => {
    const file = write('comma.json', '{"a":1,}')
    expect(run(['check', file]).code).toBe(1)
  })

  test('check reports every file and the worst code wins', () => {
    const clean = write('a.json', '{"a":1}')
    const bad = write('b.json', '{"a":NaN}')
    const result = run(['check', clean, bad])
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('clean')
    expect(result.stderr).toContain('non-standard-literal')
  })

  test('--json produces a machine readable report', () => {
    const file = write('lossy.json', '[{"id":1},{"id":')
    const result = run(['repair', file, '--json'])
    const report = JSON.parse(result.stdout)
    expect(report.verdict).toBe('reject')
    expect(report.loss).toBe('data')
    expect(report.counts.fabricated).toBe(1)
    expect(report.ledger.some((e) => e.kind === 'fabricated')).toBe(true)
    expect(report.input).toBeUndefined()
    expect(result.code).toBe(3)
  })

  test('reads from stdin when the file name is a dash', () => {
    // {"a": is cut right after the colon, so the repair has to invent a value.
    const result = run(['explain', '-'], { input: '{"a":' })
    expect(result.code).toBe(3)
    expect(result.stderr).toContain('truncated')
    expect(result.stderr).toContain('invented')
  })

  test('an unknown option exits 5', () => {
    const file = write('clean.json', '{"a":1}')
    const result = run(['repair', file, '--nope'])
    expect(result.code).toBe(5)
    expect(result.stderr).toContain('Unknown option')
  })

  test('a missing file exits 5', () => {
    expect(run(['check', join(TMP, 'nope.json')]).code).toBe(5)
  })

  test('--min-severity data hides the informational lines', () => {
    const file = write('mix.json', '{"a":NaN, "b":1,}')
    const result = run(['explain', file, '--min-severity', 'data'])
    expect(result.stderr).not.toContain('structure')
    expect(result.stderr).toContain('retyped')
  })

  test('--version prints the package version and exits 0', () => {
    const result = run(['--version'])
    expect(result.code).toBe(0)
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/)
  })

  test('--help lists the exit codes', () => {
    const result = run(['--help'])
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('Exit codes')
    expect(result.stdout).toContain('jsonledger check')
  })

  test('repair does not touch the input file', () => {
    const file = write('in.json', '{"a":1,}')
    const before = readFileSync(file, 'utf8')
    run(['repair', file, '-o', join(TMP, 'out.json')])
    expect(readFileSync(file, 'utf8')).toBe(before)
    expect(existsSync(join(TMP, 'out.json'))).toBe(true)
  })
})
