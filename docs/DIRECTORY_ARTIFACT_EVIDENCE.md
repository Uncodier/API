# Directory artifact evidence

`readArtifactProof` previously used `stat -c %s` followed by `head -c 4000`
for every non-glob path. Directories such as `supabase/migrations` therefore
became `not_evaluable`, even when their SQL files existed and schema tests passed.

## Collection contract

Non-glob artifacts now use a host-owned, read-only Node script. It distinguishes
files from directories and emits typed source evidence (`kind`, child `entries`,
byte sizes, excerpts and truncation flags). Directory `bytes` is the sum of
inspected child file sizes, **not** the directory's filesystem metadata size.

- Discovery is bounded to 200 visited entries, 20 eligible files, three nested
  directory levels, and a five-second command timeout. Incomplete discovery is
  `not_evaluable`, not a successful arbitrary sample.
- Child paths are sorted. At most 4,001 bytes are read per file; directory child
  excerpts share a 3,200-character budget and the aggregate excerpt is capped at
  4,000 characters. Excerpt truncation is explicit and is not full SQL validation.
- A path with a `migrations` segment collects only SQL files. Other directories
  collect eligible text/source files, not arbitrary binary contents.
- Hidden, secret/credential-named and generated/dependency paths are excluded.
  Symlinks (including ancestor and in-workspace links), hardlinked files, special
  files and invalid UTF-8 are not read as evidence. Basename-only no-follow opens
  use a pinned parent working directory and identity checks; links cannot redirect
  a content read outside the repository. Recognizable credentials in eligible
  source are redacted before output clipping. This is defense in depth, not
  permission to store credentials in source.
- Empty directories, placeholders and zero-byte SQL do not pass. Missing paths
  remain distinct from unreadable, unsafe, interrupted or bounded-out probes.

Existing glob collection, route probes, migration application/receipt verification,
lifecycle, workflow, orchestrator and harness-diagnostics are outside this change.

## Acceptance boundary

Git reports changed files rather than changed directories. A directory artifact
claim therefore requires an **inspected, nonempty changed child** under the exact
directory prefix. Uninspected/deleted children, unchanged SQL and similarly named
directories cannot supply freshness. Semantic matching uses changed child content,
not names in a directory listing.

For the NEX CARGO criteria, SQL defining `users`, `vehicles`, `loads` and `bids`
can supply source-artifact evidence for creation. It does **not** establish that
those migrations were applied to Supabase. Schema-test output, filenames and
receipt absence cannot satisfy the application criterion. That still needs an
independent, current database/application receipt under the existing verification
contract. This patch neither creates nor interprets migration receipts and does
not execute SQL. A legacy file-only directory claim mentioning application or
deployment is also not accepted from source evidence alone.

## Offline verification

The `feature-artifact-evidence.test.ts` Jest suite executes the actual sandbox
script using Node and temporary files with a test-only child environment (no
inherited credentials). It covers
directory/regular-file compatibility, bounds, SQL excerpts, empty/missing paths,
permission/transport failure, links (including concurrent replacements), hardlinks,
FIFOs, binary data, synthetic credential exclusion/redaction, changed-child matching
and the creation-versus-application boundary. No `.env`, external provider or
production database is used. PGlite is unnecessary here: filesystem collection,
not SQL execution, is the regression under test.

Run from `/Users/prado/Desktop/Proyectos/Uncodie/Code/API`:

```sh
/opt/homebrew/opt/node@22/bin/node ./node_modules/jest/bin/jest.js \
  --config jest.harness.config.js --runInBand \
  --testPathPattern='feature-artifact-evidence|feature-coverage|archetype-semantic-evidence|judge-constraints|step-archetype-postgate'
```

Validation checkpoint: focused artifact regressions passed **5 suites / 83 tests**;
the final combined harness run passed **165 suites / 2,365 tests**. TypeScript
checking of all 25 changed TypeScript files reported no diagnostics. These results
verify local contracts, not live migration application or release of holds.