# NOTICE

## Upstream

This repository is a derivative of **jsonrepair** by Jos de Jong.

- Source: https://github.com/josdejong/jsonrepair
- Forked at commit: `4a80ed87fb1155db064945bc2aa4f6b4f4e89c27` (`chore(release): 3.15.0`)
- License: ISC — see `LICENSE.md`, which is the upstream license file, unmodified.

```
The ISC License

Copyright (c) 2020-2026 by Jos de Jong
```

The complete upstream commit history up to the fork point is preserved in this repository. All
commits before the fork commit are upstream's; everything after it is the derivative's.

## What the derivative adds

The repair engine is not modified, not vendored, not patched. It lives in the same tree because this
is a fork, but `npm run exactness:check` hashes every inherited file against the fork commit and
fails if one of them changes:

```console
$ npm run exactness:check
exactness: 46/46 upstream files unchanged (fork 4a80ed8)
```

Files and directories created by the derivative (ISC, Copyright (c) 2026 llinok111):

```
src/ledger/                     scanner, aligner, ledger, formatter, tests
bin/jsonledger.js               the jsonledger CLI
test-lib/ledger-cli.test.js     CLI contract tests
test-lib/ledger-lib.test.js     package export map tests
tools/bench/                    corpus harvester, corruption generator, benchmark
tools/checks/                   upstream-unchanged guard and its baseline
docs/                           design notes and benchmark output
NOTICE.md                       this file
```

Files modified by the derivative (metadata only, never engine code):

```
package.json        name, version, description, bin, exports, scripts, files, engines
package-lock.json   regenerated after the rename
README.md           documents jsonledger first, keeps the upstream docs below it
```

## Why the fork keeps upstream's history

A derivative that audits another library should be falsifiable: it must be possible to check that the
audited behaviour is really upstream's, not a re-implementation with its own bugs. Keeping the history
and the byte hashes makes that check mechanical instead of a promise.

## Trademarks

`jsonrepair` is the name of the upstream project. This derivative uses a different package name and
does not claim to be the upstream project; issues about repair behaviour belong upstream, issues about
the ledger belong here.
