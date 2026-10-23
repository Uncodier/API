# Dependency security review — 2026-10-22

## Applied updates

Next.js is pinned to the stable `16.4.2` release. MCP SDK, Axios,
Nodemailer, Mailparser, Workflow, Jest, and compatible transitive dependencies
were updated to address the npm advisories reported during this review.
Jest 30 is paired with compatible `ts-jest` and Jest types. React remains on
the existing compatible React 19 release.

The following overrides intentionally cross a consumer's dependency range:

- ImapFlow uses the root Nodemailer specification (`$nodemailer`) instead of
  its vulnerable pinned release. The HTTP proxy deep import remains available.
- Tailwind Typography uses `postcss-selector-parser` >=7.1.7 instead of its
  pinned 6.x release, covering recursion and flat-selector complexity fixes.
- KaTeX uses >=0.18.2 within the 0.18 release line to fix inherited option
  handling, including the trust restriction bypass.
- The existing Undici override is updated to the patched `7.29.1` release.

## Unfixed upstream advisory

[GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm)
affects every published Braces release through `3.0.3`. No patched release
was available at the time of this review. Deeply nested brace patterns can
exhaust the stack during recursive AST traversal.

The remaining dependency chain is:

```text
nextra-theme-docs → nextra → fast-glob → micromatch → braces@3.0.3
```

The full and production-only audits each report five high-severity affected
packages in this chain, but they originate from this single advisory. They
are not five independent vulnerabilities. There are no remaining critical,
moderate, or low findings in those audit results.

Nextra 4.6.1 and its matching theme remain installed. The downgrade proposed
by `npm audit fix --force` changes Nextra's major version and is not applied.
Downgrading Braces does not fix this advisory. No audit exclusions, severity
suppression, or manual modifications to installed packages are used.

This is a residual risk, not a verified false positive or a completed fix.
The inspected Nextra integration constructs filesystem/configuration glob
patterns; this does not establish that every deployed path is unreachable
from untrusted input. Do not expose arbitrary user-supplied glob patterns to
this chain. If such input is needed, enforce a nesting-depth limit before
parsing or isolate processing with enforceable resource limits. Reassess on
the next dependency update or when upstream publishes a patch.

## Verification

```sh
npm run test:dependencies
npm run test:upgrade-regressions
npm run test:voice
npm run test:transactional-email
npm run test:harness
npm run test:harness:agent
npm run test:status
npm run typecheck
npm run build
npm audit
npm audit --omit=dev
```

The dependency suite checks offline MIME round-tripping, ImapFlow's actual
Nodemailer resolution and loopback-only HTTP CONNECT success/failure, MDX math
rendering, inherited KaTeX trust rejection, and Tailwind Typography generation.
It does not verify a real SMTP provider, TLS handshake, or deployed application.
It runs with Node's test runner, separately from Jest, and is included in the
offline harness CI job. Both audit commands continue to exit nonzero while
the upstream Braces advisory remains.

### Local validation results

- `npm run typecheck` passes after adopting Nodemailer's named type exports and
  accurately typing Jest 30 mocks. The initial type-only migration preserved
  all 581 assertion lines; the follow-up below corrects obsolete expectations
  and adds regression coverage without removing security assertions.
- Dependency smoke tests: 6 passed; transactional email: 93 passed;
  email setup: 30 passed; harness: 3,362 passed; agent harness: 413 passed;
  status and cron status: 614 passed; commands: 92 passed; scheduling: 83 passed;
  AI: 1,050 passed; catalog Jest tests: 213 passed. These suite totals overlap.
- The previously failing expanded regressions are repaired:
  `npm run test:upgrade-regressions` passes all 9 ESM suites / 216 tests;
  `npm run test:voice` passes all 46 suites / 885 tests; exact delivery passes
  all 9 suites / 99 tests. The original ESM configuration also passes the five
  directly affected suites (74 tests). No cited ESM or Voice failure is deferred.
- `npm ci --dry-run --ignore-scripts --no-audit --no-fund` passes; the manifest
  and lockfile root dependency specifications match.
- `npm run build` passes, including Webpack compilation, TypeScript checking,
  generation of all 381 static pages, and the Pagefind postbuild index.
  Webpack reports a dynamic dependency
  warning in `@vercel/queue`, reached through Workflow's Vercel integration.

### Follow-up regression repair

The earlier expanded validation exposed stale test contracts, not a reason to
leave those suites broken. The repairs retain the existing production behavior:

- The isolated publish routing mock supplies the licensed-resource dependency.
  Instagram DM assertions now require the authorized site argument.
- Bulk routing fixtures implement the real licensed-resource RPC projection,
  including `license_suspended`, effective plan and `abortSignal`. They reject
  raw-settings authorization and test suspended/missing-projection denial before
  recipient reads, writes, template preparation, or provider dispatch.
- The Voice queue test mocks the exact-delivery boundary it actually imports
  rather than obsolete email adapters, preventing unrelated ESM provider imports.
  It retains the real routing, consent checks, personalization and queue logic,
  and verifies the exact licensed connection and missing-projection denial.
- Authentication and MCP lifecycle tests implement the real abortable database
  builder. They verify that Redis sampling failures retain the observation,
  contention suppresses duplicates, and Redis admission failures remain
  fail-closed. Safe warning and individual secret-absence assertions cover
  synthetic database errors; no sampling or admission policy is changed.
- Outstand authorization tests configure/restore their own synthetic environment
  and forbid live HTTP. They additionally test missing-configuration denial.
- The 601-request admission regression retains every request and redaction
  assertion with a scoped 30-second Jest budget for slower CI hosts. This does
  not alter production rate limits or request deadlines. The previous five-second
  timeout could leave its unfinished loop contaminating the following test.

The new ESM regression command and complete Voice suite run in the offline
harness CI job. This verifies the affected suites, not a claim that every
legacy test in the repository was executed.

Local execution used Node 25.9.0. The offline CI job uses Node 22; this local
run is not a substitute for that CI result or deployment validation.