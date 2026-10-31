# Offline MCP regression strategy

Run from `/Users/prado/Desktop/Proyectos/Uncodie/Code/API`:

```bash
npm run test:mcp
```

Requires the project's installed dependencies and supported Node version. The
command runs three Jest configurations sequentially (ESM SDK contracts, CJS
security/routing regressions, and procurement). It does not start Next, load
Next configuration or `.env` files, run migrations, or contact providers.

## Coverage map

| Suite | Boundary covered |
| --- | --- |
| `src/lib/mcp/__tests__/server-contract.test.ts` | Real SDK client/server over linked in-memory transport: capabilities, discovery, Zod/defaults/transforms/action unions, recursive JSON Schema, invalid inputs before execution, results, protocol errors, concurrency, redaction and fail-closed remote proxy |
| `src/lib/mcp/__tests__/auth.test.ts` | Legacy MCP credential helper: extraction, precedence, service/DB decisions and fail-closed DB failure |
| `src/lib/mcp/__tests__/remote-client.test.ts` | Mode selection, URL/header composition, success/failures, single-read error bodies, no retries, stderr-only safe diagnostics |
| `src/lib/mcp/__tests__/stdio.test.ts` | Real subprocess and SDK stdio transport, protocol-only stdout, lifecycle, context isolation and isolated production entrypoint bootstrap |
| `src/app/api/mcp/__tests__/http-contract.test.ts` | Real SDK HTTP transport routed in memory to production POST: negotiation, protocol/media validation, notifications, Origin, authorization, independent contexts and teardown |
| Existing MCP context/route suites | UUID/default sentinel, real history reader/router with mocked database boundary, authentication and invalid server configuration |
| Existing screen/principal/router suites | Host-owned identity, cross-site denial, effective/revoked screen access, discovery and execution protection |
| Existing executor and Redis lifecycle suites | Native MCP routing, command context, rate-limit failure and telemetry lifecycle |
| Existing procurement suites | Domain schemas/policy/discovery, approval orchestration, SQL adapter with PGlite recording stubs and legacy quotation boundary |

All credentials used in new fixtures are generated at runtime with `node:crypto`.
Application catalogs and external I/O are explicitly replaced. SDK transports
and protocol parsing are real, except bootstrap-specific lifecycle unit tests.
Fixtures do not constitute permission to execute business writes in production.

## Regression fixes protected by these tests

- The HTTP JSON-mode server closes after each response, including failure paths.
- Standalone GET returns 405 (no SSE offered); unlisted Origins are denied.
- Remote discovery fails closed rather than substituting the local catalog.
- The MCP proxy validates response envelopes/results and uses a bounded request
  signal with redirects disabled; it does not retry interrupted writes.
- Local Zod schemas are parsed before execution, including transformations and
  defaults; plain schemas use the installed SDK's JSON Schema validator.
- The `tools` router retains its documented inline-object compatibility by
  JSON-encoding its `args` before validating its provider-oriented string schema.
- Undefined tool results serialize as `null`; sensitive diagnostics are not
  copied into remote failure messages or stdout.

## Explicit limits

This is an offline boundary suite, not exhaustive testing of every registered
business tool. HTTP dispatch is in memory (no listener, Next build, middleware
deployment, browser CORS or TLS). The stdio subprocess uses an injected catalog;
bootstrap tests isolate the entrypoint's application imports. No LLM evaluates
tool selection, no real provider delivery is exercised, and PGlite adapter tests
are not the complete canonical procurement database lifecycle.

Deployment smoke tests, canonical database integration, load tests and model
evaluations remain separate work. Keep real credentials out of tracked fixtures,
logs and snapshots; see `docs/SECRET_SCANNING.md`.