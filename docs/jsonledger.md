# jsonledger design notes

This document records why the ledger is built the way it is, what it can and cannot see, and what was
measured. Everything here is reproducible from the repository.

## 1. The problem being solved

`jsonrepair` maps `string -> string`. A caller cannot distinguish these four outcomes:

| outcome | signal available to the caller |
|---|---|
| the text only needed quoting/commas | a string comes back |
| the text was truncated, so the tail is gone | a string comes back |
| the text was cut mid-value, so a value was invented | a string comes back |
| a literal was silently retyped (`NaN` → `"NaN"`) | a string comes back |

Upstream does the right thing for its own scope: it is a repair engine, not a linter. Adding
reporting to it would change a 3.x public API and couple the string machine to a second
representation. A separate layer that *reads the two texts* keeps the engine untouched and can be
verified against it.

## 2. Why not diff the two texts

A character diff is useless here: every repair rewrites quotes and escapes, so the diff is dominated
by noise. A tree diff of `JSON.parse(source)` is impossible: the source does not parse — that is the
whole problem.

So the ledger works on **value tokens**: keys and scalar values, in document order, with offsets. Two
texts become two token streams, and a repair is a mostly-local edit of one stream into the other.

## 3. Scanner

`src/ledger/scan.ts` — one linear pass, no backtracking, never throws.

It tracks a stack of containers so each token gets a JSON path (`$.a[2].b`) and so structural
expectations can be checked (`key` / `colon` / `value` / `comma`). Alongside the tokens it emits
defects with offset, line, column, path and severity.

Deliberate choices:

- **Bare tokens absorb colons.** `https://host/path`, `C:\temp\x`, `12:30` are one token, not a token
  plus a colon error. A colon only ends a token where JSON grammar expects one (after a key).
- **A single-quoted string is not closed by `"`.** `{'a':'he said "hi"'}` is one string with an inner
  quote. Getting this wrong produced 16 false data-loss reports on the benchmark corpus before it was
  fixed — see §7.
- **A trailing comma is one defect, not two.** It used to also report the following closer as a
  missing value.
- **An empty `[]` never means "missing value".** The same mistake made 11 of 600 real package
  manifests look broken. An empty `{}` is not a defect either.
- **Unclosed constructs are reported where they open, innermost first**, so a truncation points at the
  bracket a human would look for.

### Defect codes

| code | severity | meaning |
|---|---|---|
| `bom` | cosmetic | byte order mark before the document |
| `comment` | cosmetic | `//` or `/* */` outside a string |
| `markdown-fence` | cosmetic | ` ```json ` wrapper |
| `single-quote` | syntax | string delimited by `'` |
| `smart-quote` | syntax | string delimited by `“ ”` or `‘ ’` |
| `unquoted-key` | syntax | key without quotes |
| `trailing-comma` | syntax | comma before a closer |
| `double-comma` | syntax | two commas in a row |
| `missing-comma` | syntax | two members without a separator |
| `missing-colon` | syntax | key without a colon |
| `unexpected-colon` | syntax | colon where JSON has no place for one |
| `raw-newline-in-string` | syntax | unescaped newline inside a string |
| `raw-control-char` | syntax | unescaped control character inside a string |
| `unquoted-value` | data | bare word where a value is expected |
| `non-standard-literal` | data | `NaN`, `Infinity`, `undefined` |
| `invalid-number` | data | `0.0.1`, `2020-01-01`: looks numeric, is not a JSON number |
| `missing-value` | data | `{"a":}` |
| `unexpected-closer` | data | closer without a matching opener |
| `unclosed-string` | data | string never closed |
| `unclosed-object` | data | object never closed |
| `unclosed-array` | data | array never closed |
| `ellipsis` | data | `...` instead of members |
| `duplicate-key` | data | the same key twice in one object |
| `empty-document` | data | no JSON value at all |

Severity means "what does fixing this risk", not "how bad is the syntax": `data` defects are the ones
where the repair has to guess.

## 4. Alignment

`src/ledger/align.ts` — both token streams are walked once, monotonically, with a lookahead window of
8 tokens.

For every output token we look ahead in the input stream for the same value:

- no match → **fabricated** (`severity: data`)
- skipped input tokens → **dropped** (`data`), except `...` which becomes **elided** (`warn`) because
  it marks content that was never written, not content that was lost
- matched but JSON type differs → **coerced**; `data` when a bare `NaN`/`Infinity` became a string,
  `warn` when the source was never valid JSON anyway (`0.0.1`), `info` when it was only requoting
- matched but the path *shape* differs → **restructured** (`data`)

The lookahead window exists because repairs are local: at most a few tokens are inserted or removed at
a time. A larger window buys nothing on this class of edit and costs worst-case time; a smaller one
starts misaligning on quoted keys that follow a repaired member.

### The hole tokens cannot see, and the guard

An empty container has no scalar inside it. `[{},,{"a":1}]` becomes `[[{}],{"a":1}]` and every scalar
token keeps its path — so alignment reports nothing. The guard compares container opening counts
between input and output and raises `restructured` when they differ, skipping truncated documents where
unbalanced brackets are expected. This was found by the benchmark, not by a unit test.

## 5. Verdict

```
loss: none < cosmetic < type < truncated < data
```

| loss | verdict | CLI exit |
|---|---|---|
| `none` | `ok` | 0 |
| `cosmetic` | `cosmetic` | 1 |
| `type` | `review` | 2 |
| `truncated` | `review` | 2 |
| `data` | `reject` | 3 |

`unrepairable` (upstream threw, or returned the input unchanged while it is still invalid) is exit 4
and always has `output: null`. With `policy: 'safe'`, a `reject` also returns `output: null` plus a
`refused` string, so a caller cannot accidentally persist a lossy document.

The CLI does not emit a `reject` document on stdout unless `--force` is given. This is the whole
point: the default path cannot silently write back invented data.

## 6. Measured evidence

`tools/bench/` builds a corpus of valid JSON from a directory tree, applies nine seeded corruptions
with known ground truth, and compares what jsonrepair produced with what the ledger said.

Two families:

- **lossless** (`trailing-comma`, `single-quote`, `unquoted-keys`, `comments`, `bom`, `messy`): the
  corruption cannot change meaning, so any `data` verdict is a false alarm.
- **destructive** (`truncate`, `special-literal`, `ellipsis`, `double-comma`): information is lost,
  invented or re-nested, so anything below `review` is a miss.

Result on 600 documents (`docs/bench-600.json`, seed 20261028):

| | value |
|---|---|
| valid JSON round trip, identical bytes | 600/600 |
| lossless samples | 3596 |
| false alarms | 0 |
| destructive samples | 2236 |
| detected | 2236 |
| destructive input that upstream repaired silently | 1798/2236 |
| of those, semantic drift | 1204 |

The `ellipsis` row is worth reading closely: upstream deletes `...` and the result is *semantically*
identical when nothing was elided, so 594/594 of those were "silent successes". The ledger still
reports them as `truncated`/`review`, because the text said "there was more here" and the repair
cannot know whether that was true. That is a deliberate policy choice, not a measurement artefact.

## 7. Bugs the benchmark found (kept as regression tests)

1. A single-quoted string containing `"` was split in two → 8 false alarms per class.
2. An empty `[]` was reported as a missing value → 11 false positives on 600 real manifests.
3. A doubled array comma changes nesting, which token order cannot see → `[1,2,,3]` was passing as
   cosmetic.
4. An empty object wrapped in an array changed container count but no token path → the container-count
   guard.
5. `...` was counted as dropped data, which made every ellipsis a `reject` instead of `review`.

Each one is a test now (`src/ledger/scan.test.ts`, `src/ledger/repair.test.ts`). None of them was
found by a hand-written unit test; all five were found by running the ledger against a corpus.

## 8. Deliberate non-goals

- **Not a repair engine.** No repair logic is implemented here. If upstream cannot repair a document,
  the ledger says `unrepairable` and stops.
- **Not a validator.** `diagnose()` reports what a strict parser would reject plus what a repair would
  have to guess, but it is not a JSON Schema validator and does not resolve `$ref`.
- **Not a formatter.** The ledger never rewrites whitespace, key order or indentation, and a valid
  document is returned byte for byte. `--min-severity` and `--json` change the report, never the
  document.
- **Not a streaming tool.** Auditing requires both texts in memory. The streaming transform stays
  upstream's, unaudited, and the README says so.
