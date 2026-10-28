#!/usr/bin/env node
/**
 * jsonledger CLI: report what a jsonrepair repair actually did.
 *
 * Exit codes (contract, covered by tests):
 *   0  document is clean, nothing to repair
 *   1  defects found, repair is lossless (quotes, commas, comments, BOM)
 *   2  repair needs review (truncated document, value type changed)
 *   3  repair would invent or drop data
 *   4  document could not be repaired at all
 *   5  usage or I/O error
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { formatReport } from '../lib/esm/ledger/format.js'
import { diagnose, repair } from '../lib/esm/ledger/index.js'

const EXIT = { ok: 0, cosmetic: 1, review: 2, reject: 3, unrepairable: 4, usage: 5, io: 5 }

const help = `
jsonledger
https://github.com/llinok111/jsonledger

Explain what jsonrepair did to a document, and refuse repairs that lose data.

Usage:
    jsonledger check  <file...>            diagnose only, never repairs
    jsonledger repair <file>               repair, print the ledger, then the document
    jsonledger explain <file>              repair, print the ledger only

Options:
    --output, -o <file>   write the repaired document to a file
    --json                machine readable report on stdout
    --force               also emit a document the ledger rejected
    --min-severity <s>    info | warn | data (default: info)
    --no-report           suppress the human readable report
    --version, -v         show version
    --help, -h            show this message

Use "-" or no file name to read from stdin.

Exit codes:
    0 clean   1 lossless repair   2 needs review   3 lossy repair   4 unrepairable   5 usage

Examples:
    jsonledger check config.json
    jsonledger repair broken.json -o fixed.json
    cat broken.json | jsonledger explain -
    jsonledger repair config.json --json | jq .counts
`

function parseArgs(argv) {
  const options = {
    command: null,
    files: [],
    output: null,
    json: false,
    force: false,
    report: true,
    minSeverity: 'info'
  }
  const args = argv.slice(2)
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    switch (arg) {
      case '-h':
      case '--help':
        options.command = 'help'
        break
      case '-v':
      case '--version':
        options.command = 'version'
        break
      case '-o':
      case '--output':
        options.output = args[++i]
        break
      case '--json':
        options.json = true
        break
      case '--force':
        options.force = true
        break
      case '--no-report':
        options.report = false
        break
      case '--min-severity':
        options.minSeverity = args[++i]
        if (!['info', 'warn', 'data'].includes(options.minSeverity)) {
          throw new Error(`--min-severity expects info, warn or data, got "${options.minSeverity}"`)
        }
        break
      default:
        if (arg.startsWith('-') && arg !== '-') throw new Error(`Unknown option "${arg}"`)
        if (options.command === null) options.command = arg
        else options.files.push(arg)
    }
  }
  if (options.command === null) options.command = 'help'
  return options
}

function readInput(file) {
  if (file === '-' || file === undefined) return readFileSync(0, 'utf8')
  return readFileSync(file, 'utf8')
}

function runCheck(options) {
  if (options.files.length === 0) throw new Error('check needs at least one file')
  let worst = EXIT.ok
  const results = []
  for (const file of options.files) {
    const text = readInput(file)
    const result = diagnose(text)
    results.push({ file, ...result })
    if (!result.ok) {
      const data = result.defects.some((d) => d.severity === 'data')
      worst = Math.max(worst, data ? EXIT.review : EXIT.cosmetic)
    }
    if (!options.json) {
      const name = file === '-' ? '<stdin>' : file
      if (result.ok) {
        process.stderr.write(`${name}: clean\n`)
      } else {
        process.stderr.write(
          `${name}: ${result.defects.length} defect${result.defects.length > 1 ? 's' : ''}\n`
        )
        for (const d of result.defects) {
          process.stderr.write(
            `  line ${d.line}:${d.column}  ${d.code.padEnd(22)} ${d.severity.padEnd(8)} ${d.message}\n`
          )
        }
      }
    }
  }
  if (options.json) process.stdout.write(`${JSON.stringify(results, null, 2)}\n`)
  return worst
}

function runRepair(options, emitDocument) {
  const file = options.files[0]
  if (options.files.length > 1) throw new Error('repair takes a single file')
  const text = readInput(file)
  const result = repair(text, { minSeverity: options.minSeverity })

  if (options.json) {
    process.stdout.write(`${JSON.stringify({ ...result, input: undefined }, null, 2)}\n`)
  } else if (options.report) {
    process.stderr.write(formatReport(result, { showDefects: options.minSeverity !== 'data' }))
  }

  if (emitDocument && result.output !== null) {
    const allowed = ['ok', 'cosmetic', 'review'].includes(result.verdict) || options.force
    if (allowed) {
      if (options.output) writeFileSync(options.output, result.output)
      else process.stdout.write(result.output)
    } else {
      process.stderr.write('refusing to emit a lossy document; use --force to override\n')
    }
  }

  return EXIT[result.verdict] ?? EXIT.usage
}

function outputVersion() {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  process.stdout.write(`${pkg.version}\n`)
}

try {
  const options = parseArgs(process.argv)
  switch (options.command) {
    case 'help':
      process.stdout.write(help)
      process.exit(EXIT.ok)
      break
    case 'version':
      outputVersion()
      process.exit(EXIT.ok)
      break
    case 'check':
      process.exit(runCheck(options))
      break
    case 'repair':
      process.exit(runRepair(options, true))
      break
    case 'explain':
      process.exit(runRepair(options, false))
      break
    default:
      process.stderr.write(`Unknown command "${options.command}"\n${help}`)
      process.exit(EXIT.usage)
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(EXIT.usage)
}
