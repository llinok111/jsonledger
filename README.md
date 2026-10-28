# jsonledger

**jsonrepair tells you the repaired document. jsonledger tells you what the repair did to your data.**

`jsonledger` is a derivative of [jsonrepair](https://github.com/josdejong/jsonrepair) (3.15.0, ISC).
It does not repair anything itself: every repair is still performed by jsonrepair, byte for byte.
What it adds is an audit layer — a defect list with positions, a per-mutation ledger, a loss level
and a verdict — because a repair that silently invents, drops or retypes data is worse than a
repair that fails loudly.

```console
$ cat broken.json
[{"id":1},{"id":2},{"id":

$ npx jsonledger explain broken.json
verdict: reject   loss: data
source: 25 B  ->  32 B
defects: 2   invented: 1   dropped: 0   retyped: 0   nesting: 0   comments removed: 0

  DATA                  invented  $[2].id  null
                        value exists only in the repaired document
  WARN line 1:1         truncated $
                        document ends inside 2 unclosed constructs; the tail is unknowable
```

jsonrepair repairs that input too — and hands you `[{"id":1},{"id":2},{"id":null}]` with no
indication that the last record never existed.

## Why this exists

jsonrepair is the de-facto fixer for malformed JSON and it is good at it. But its public surface is
one function that returns a string, or throws. Everything else is invisible:

| What the repair does | What jsonrepair reports | What jsonledger reports |
|---|---|---|
| `{"a":NaN}` → `{"a":"NaN"}` | nothing (returns a string) | `coerced` at `$.a`, severity `data` |
| `[{"id":1},{"id":` → `…{"id":null}]` | nothing | `fabricated` at `$[2].id`, severity `data` |
| `{"a":1, ...}` → `{"a":1}` | nothing | `elided`, severity `warn` |
| `[1,2,,3]` → `[[1,2],3]` | nothing | `restructured`, severity `data` |
| `{"a":1` (truncated) | nothing | `truncated`, severity `warn` |
| `{a:1}` → `{"a":1}` | nothing | `requoted`, severity `info` |

## Measured, not asserted

Reproduce (the repo's own `node_modules` is the corpus):

```console
npm run build
node tools/bench/run.mjs node_modules --limit 600 --json docs/bench-600.json
```

600 valid JSON documents, seeded corruptions with known ground truth, 9 corruption classes.

| | jsonrepair | jsonledger |
|---|---|---|
| valid JSON in, same bytes out | 600/600 | 600/600 (`verdict: ok`) |
| lossless corruptions flagged as lossy (3596 samples) | 0 (no signal to give) | 0 false alarms |
| destructive corruptions detected (2236 samples) | 0 (no signal to give) | 2236 (100%) |
| destructive input that still produced a document | 1798/2236 | — |
| …of those, a document that no longer means the same thing | 1204 | flagged `data` |
| median time per document, warm, single process | 0.029 ms | 0.086 ms |

The point is not that jsonledger repairs *better* — it does not repair at all. The point is that on
1204 real documents upstream returned a plausible looking result whose meaning had changed, with
nothing in the return value to say so.

Per-class numbers: [docs/bench-600.json](docs/bench-600.json).

## Install

```console
npm install jsonledger
```

Node.js 18 or newer. No runtime dependency beyond the upstream engine itself.

## Usage

### Audit a repair

```js
import { repair } from 'jsonledger/ledger'

const result = repair('{"a":NaN,"b":1,}')

result.verdict // 'reject'
result.loss // 'data'
result.output // '{"a":"NaN","b":1}'
result.counts // { defects: 2, fabricated: 0, dropped: 0, coerced: 1, restructured: 0, requoted: 0, commentsRemoved: 0 }
result.ledger // [{ kind: 'coerced', severity: 'data', path: '$.a', detail: 'bare NaN is not a JSON value and became a string', … }]
result.defects // [{ code: 'non-standard-literal', line: 1, column: 6, severity: 'data', path: '$.a', … }]
```

### Refuse lossy repairs

```js
import { repair } from 'jsonledger/ledger'

const result = repair(text, { policy: 'safe' })
if (result.output === null) {
  console.error(result.refused)
  // refused: repair would invent data (0 dropped, 1 invented, 0 retyped)
}
```

### Diagnose without repairing

```js
import { diagnose } from 'jsonledger/ledger'

const { ok, validJson, defects } = diagnose('{a:1,}')
// ok: false, validJson: false
// defects: [{ code: 'unquoted-key', line: 1, column: 2, … }, { code: 'trailing-comma', … }]
```

### Audit a repair someone else produced

```js
import { verify } from 'jsonledger/ledger'

verify('{"a":1,"b":2}', '{"a":1}')
// { equal: false, loss: 'data', ledger: [{ kind: 'dropped', path: '$.b', … }] }
```

### CLI

```console
jsonledger check  <file...>          # diagnose only, never repairs
jsonledger repair <file>             # repair, print the ledger, then the document
jsonledger explain <file>            # repair, print the ledger only
```

Options: `--json`, `--output/-o <file>`, `--force`, `--min-severity <info|warn|data>`,
`--no-report`. Use `-` to read from stdin.

Exit codes are a contract, covered by tests:

| code | meaning |
|---|---|
| 0 | document is clean |
| 1 | defects found, repair is lossless (quotes, commas, comments, BOM, fences) |
| 2 | needs review (document truncated, or a value changed type) |
| 3 | repair would invent or drop data — the document is **not** emitted |
| 4 | document could not be repaired at all |
| 5 | usage or I/O error |

## Loss levels

| level | meaning | example |
|---|---|---|
| `none` | nothing changed | valid JSON in |
| `cosmetic` | bytes changed, meaning identical | `{a:1}` → `{"a":1}` |
| `type` | a value survived but changed JSON type | `0.0.1` → `"0.0.1"` |
| `truncated` | the document ended mid-construct, or contained an ellipsis; what followed is unknowable | `{"a":1` |
| `data` | a value was invented, dropped, destructively retyped, or re-nested | `NaN` → `"NaN"`, `[1,2,,3]` → `[[1,2],3]` |

## How the ledger works

1. A tolerant **scanner** walks the broken text once and produces (a) every key and scalar value with
   its offset, JSON path and a defect tag, and (b) a defect list with line/column and severity. It
   never repairs and never throws.
2. jsonrepair produces the repaired text.
3. An **aligner** matches the two token streams monotonically with a small lookahead. Tokens that
   only exist in the output were invented; tokens that only exist in the input were dropped; matched
   pairs whose JSON type changed were retyped; matched pairs whose path *shape* changed were
   re-nested. Container counts close the remaining hole (an empty `{}` wrapped in `[]`).
4. A **verdict** maps the findings to `ok` / `cosmetic` / `review` / `reject` / `unrepairable`.

Details, including the defect code table and the reasons behind each design choice:
[docs/jsonledger.md](docs/jsonledger.md).

## What is upstream and what is new

| path | owner |
|---|---|
| `src/regular/**`, `src/streaming/**`, `src/utils/**`, `src/index.ts`, `src/stream.ts` | upstream, untouched |
| `bin/cli.js`, `test-lib/cli.test.js`, `test-lib/lib.test.js`, `tools/benchmark/**` | upstream, untouched |
| `src/ledger/**`, `bin/jsonledger.js`, `test-lib/ledger-*.test.js`, `tools/bench/**`, `tools/checks/**`, `docs/**` | this derivative |
| `README.md`, `package.json` (`name`, `bin`, `exports`, `scripts`), `package-lock.json` | modified by this derivative |

`npm run exactness:check` hashes 46 upstream files against the fork commit and fails if any changed:

```console
$ npm run exactness:check
exactness: 46/46 upstream files unchanged (fork 4a80ed8)
```

The upstream test suite still runs unmodified:

```console
$ npm run test:it
Test Files  5 passed (5)
     Tests  179 passed (179)
```

## Known limitations

1. **The ledger cannot see intent.** It reports what changed; it cannot decide whether the input meant
   `[1,2,3]` or `[[1,2],3]`.
2. **Alignment is value level.** A container without any scalar inside it can only be attributed by
   the container-count guard, so replacing one empty container with another of the same type in the
   same slot is invisible.
3. **Member reordering is not reported.** The token streams are compared in order; a repair that moved
   members around would not raise an event. jsonrepair does not do this today.
4. **Streaming is not audited.** `jsonledger/stream` is upstream's transform unchanged; the ledger
   works on complete documents only.
5. **Non-JSON dialects are guesses.** Bare tokens, `0.0.1`, `C:\temp`, URLs: reported as `requoted`
   when the text survives and `coerced` when the type is guesswork. The ledger never claims to know
   which reading the author intended.
6. **Timing is measured, not promised.** 0.086 ms is a warm, single-process median over 600 documents
   on one Windows machine; cold start and very large documents differ.
7. **Pinned to the engine it audits.** Verified against jsonrepair 3.15.0. A future upstream change in
   repair strategy can make findings noisier — the benchmark is how you would detect that.

## Development

```console
npm ci
npm run test:it        # upstream suite, 179 tests
npm run test:ledger    # ledger suite
npm run build          # esm + cjs + umd + types, then test-lib
npm run exactness:check
npm run bench          # node tools/bench/run.mjs node_modules
npm run test:all       # lint + all suites + exactness
```

## Upstream documentation (jsonrepair 3.15.0)

The engine below is jsonrepair, unchanged. `import { jsonrepair } from 'jsonledger'` behaves exactly
like `jsonrepair` from the upstream package.

### What it repairs

- Add missing quotes around keys
- Add missing escape characters
- Add missing commas
- Add missing closing brackets
- Repair truncated JSON
- Replace single quotes with double quotes
- Replace special quote characters like `“...”` with regular double quotes
- Replace special white space characters with regular spaces
- Replace Python constants `None`, `True`, and `False` with `null`, `true`, and `false`
- Strip trailing commas
- Strip comments like `/* ... */` and `// ...`
- Strip fenced code blocks like ` ```json` and ` ``` `
- Strip ellipsis in arrays and objects like `[1, 2, 3, ...]`
- Strip JSONP notation like `callback({ ... })`
- Strip escape characters from an escaped string like `{\"stringified\": \"content\"}`
- Strip MongoDB data types like `NumberLong(2)` and `ISODate("2012-12-19T06:01:17.171Z")`
- Concatenate strings like `"long text" + "more text on next line"`
- Turn newline delimited JSON into a valid JSON array
- Streaming support for very large documents

### ES module

```js
import { jsonrepair } from 'jsonledger'

const repaired = jsonrepair("{name: 'John'}")
console.log(repaired) // '{"name": "John"}'
```

### Streaming API

```js
import { createReadStream, createWriteStream } from 'node:fs'
import { pipeline } from 'node:stream'
import { jsonrepairTransform } from 'jsonledger/stream'

pipeline(
  createReadStream('./data/broken.json'),
  jsonrepairTransform(),
  createWriteStream('./data/repaired.json'),
  (err) => console.error(err)
)
```

### CommonJS

```js
const { jsonrepair } = require('jsonledger')
console.log(jsonrepair("{name: 'John'}")) // '{"name": "John"}'
```

### API

```ts
// @throws JSONRepairError
jsonrepair(json: string): string

jsonrepairTransform(options?: { chunkSize?: number, bufferSize?: number }): Transform
```

`chunkSize` and `bufferSize` default to `65536` bytes. `bufferSize` must be larger than the longest
string in the document, otherwise the transform throws "Index out of range".

### Upstream CLI

The upstream `jsonrepair` binary is still installed alongside `jsonledger`:

```console
$ jsonrepair broken.json                        # repair to stdout
$ jsonrepair broken.json --output repaired.json # repair to a file
$ jsonrepair broken.json --overwrite            # replace the input file
```

## License

ISC, same as upstream. See [LICENSE.md](LICENSE.md) (upstream, unchanged) and [NOTICE.md](NOTICE.md)
for provenance and the list of derivative files.

---

中文速览：[docs/README.zh.md](docs/README.zh.md)
