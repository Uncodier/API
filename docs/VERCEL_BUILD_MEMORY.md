# Vercel build memory and request runtime

## Two separate diagnostics

An Edge warning tracing `next/server` through `connection` into
`dynamic-rendering.js` is not the cause of a later `BUILD_UTILS_SPAWN_SIGKILL`.
When Vercel reports an OOM event during **Running TypeScript**, the build
container has exhausted RAM and terminated a process. Suppressing warnings
does not resolve that failure.

## Build configuration

The application uses Next.js 16.3.3 with Webpack, Nextra, and Workflow hooks.
Custom Webpack configuration disables Next.js's build worker by default.
`experimental.webpackBuildWorker: true` explicitly isolates compilation so its
memory can be released before type checking. `webpackMemoryOptimizations: true`
also reduces Webpack's peak heap, potentially at the cost of compilation time.
Keep server compilations/traces serial; parallelizing them increases peak RAM.

Production type checking remains enabled (`ignoreBuildErrors: false`). Strict
checking and the application/test file scope in `tsconfig.json` are unchanged.
`npm run typecheck` remains available for standalone validation with fresh route
types. These optimizations reduce retained compiler memory; they do not guarantee
that the TypeScript project itself fits every Vercel build machine.

## Request runtime

`src/proxy.js` is the sole Next.js request entrypoint, next to `src/app`.
Next.js 16 deprecated `middleware.js`; Proxy uses Node.js automatically and
does not accept an explicit `runtime` setting. The shared request policy,
`/api/:path*` and `/record` matchers, authentication, CORS, rate limits, and
`waitUntil` lifecycle forwarding are unchanged. Do not reintroduce root or
`src` middleware entrypoints alongside Proxy.

## Verification and remaining OOMs

Run the offline configuration and request-policy regressions:

```sh
npm test -- --runInBand __tests__/typescript-build.test.ts src/middleware/__tests__
node node_modules/jest/bin/jest.js --config jest.identity.config.js --runInBand src/lib/services/visitor-identity/__tests__/route-authorization-contract.test.ts
npm run typecheck
npm run build
```

If a deployment still exhausts memory:

1. Set `VERCEL_BUILD_SYSTEM_REPORT=1` in the Vercel project for complete build
   resource diagnostics and identify the phase that fails.
2. Measure standalone type checking with `tsc --noEmit --extendedDiagnostics`.
   Resolve type errors rather than bypassing production validation.
3. Review the TypeScript dependency graph and generated types if type checking
   itself is the dominant consumer. Profile one heavy check/build at a time.
4. If the checked project still exceeds available RAM, use a larger Vercel build
   machine or a separately validated build pipeline. Runtime function memory
   and `maxDuration` settings do not increase build-container RAM.

Do not blindly increase `NODE_OPTIONS=--max-old-space-size`: it is a per-process
heap ceiling, not additional container RAM, and concurrent processes need headroom.
Next.js's `--experimental-debug-memory-usage` profiling mode is incompatible
with the Webpack build worker; disable the worker only for that profiling run.
Heap profiles and build logs can contain sensitive data. Do not commit them or
copy credentials into diagnostic fixtures.

## Local validation (2026-10-20)

- The full `tsc --noEmit --incremental false --extendedDiagnostics` check passed
  before and after the final regression addition. The checks used about
  2.5–2.8 GiB of compiler memory and took 32–52 seconds; heap measurements vary
  with garbage collection and runtime conditions.
- A clean temporary production build using Node.js 22.22.2, no `.env` files,
  and no existing `.next` cache compiled successfully and passed Next.js's
  TypeScript stage. It generated `.next/server/proxy.js`; the reported
  `process.cwd` Edge warning did not appear during compilation.
- The build subsequently failed during page-data collection because
  `/api/agents/sales/regionVenues` initializes a service requiring
  `GOOGLE_CLOUD_API_KEY`. This is not a successful end-to-end build or deployment.
- The broader middleware/visitor-contract tests have four failures that also
  reproduce against unchanged baseline code: three telemetry expectations and
  one customer-support message route contract. The configuration, Proxy
  entrypoint, request-policy, and updated authorization-boundary checks pass.

Local results cannot prove that a particular Vercel build container has enough
RAM. Redeploy with the build-system report enabled to verify its peak usage.

References: [Next.js memory usage](https://nextjs.org/docs/app/guides/memory-usage),
[Proxy runtime](https://nextjs.org/docs/app/api-reference/file-conventions/proxy#runtime),
[Vercel build troubleshooting](https://vercel.link/troubleshoot-build-errors),
[Vercel build machines](https://vercel.com/docs/builds/managing-builds#enhanced-build-machines).