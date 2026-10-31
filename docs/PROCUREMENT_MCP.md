# Procurement MCP integration

## Scope

The shared assistant catalog registers six tools through the existing `tools`
router, used by both HTTP and stdio MCP. Load `makinari-procurement` or describe
each tool for strict action schemas. There is no new unauthenticated HTTP route.

- `procurement_requests`: list/get/save/submit/revalidate/decide.
- `procurement_tenders`: list/get/save/publish/transition/participant/portal.
- `procurement_quotations`: list/get/options/record (buyer-recorded proposals).
- `procurement_approvals`: list/get/create/decide (publication/award/order gates).
- `procurement_orders`: list/receive (non-stock acceptance).
- `procurement_policy`: get (no policy weakening through model arguments).

The domain implementation is the existing `market-fit` procurement module, not
legacy `purchases`. API code has no runtime imports from the sibling repository.
Pure policy schemas/evaluation are a local snapshot of that implementation and
must be reconciled when its rules change. API orchestration deliberately requires
a saved policy rather than bootstrapping one implicitly.

## Deployment

1. Deploy the canonical procurement migrations from the application repository,
   including policy versions, requests, suppliers, tenders/publications, event
   approvals, commerce lifecycle, inherited policy/revalidation, decision replay,
   free-text quotations, envelopes, receipt activity and quotation detail. The
   required current domain includes the October 30, 2026 updates through
   `20261030220000_procurement_quotation_detail.sql`.
2. Apply the API migration `20261031010000_procurement_mcp_bridge.sql` after those
   dependencies. This migration is an adapter, not a replacement domain schema.
3. Deploy this API with the existing Supabase service-role configuration. No new
   credentials or JWT-signing secrets are needed. Do not expose the service key
   to MCP clients. Authenticate MCP normally so its host resolves the real actor.
4. Verify an active owner/admin can discover and read the policy, then exercise a
   draft workflow in a test workspace. Tool discovery is not a database health check.

Missing domain/bridge functions fail closed. No production database migration or
business operation is performed by the offline test suite.

## Security boundaries

- Workspace and actor come from a host-owned closure. Strict action schemas reject
  tenant/actor overrides, arbitrary RPC names, approval plans and direct statuses.
- Screen authorization is checked on execution and again before approval commit.
  Discovery, search, describe and execution use the same `blocked_screens` mapping
  as other tools, without an additional `adminOnly` catalog restriction:

  | Tool | Required screen |
  | --- | --- |
  | `procurement_requests` | `purchaseRequests` |
  | `procurement_tenders` | `procurementTenders` |
  | `procurement_quotations` | `purchasesQuotes` |
  | `procurement_orders` | `purchasesOrders` |
  | `procurement_approvals` | `procurementApprovals` |
  | `procurement_policy` | `procurementRules` |

  Administrators retain the shared screen exemption; revoked effective access
  still denies them. Screen authorization is necessary, not sufficient: the
  canonical procurement SQL currently also requires owner/admin and unrestricted
  location access. Removing the catalog-only role gate does not relax those
  business rules or grant collaborators new database authority.
- The service-only SQL dispatcher validates canonical actor, role, unrestricted
  location and command permissions. Its operation allowlist is fixed; it does not
  execute model-provided SQL or function names. Actor claims are transaction-local
  and restored. Model input cannot reach the trusted plan parameter.
- Publication, award and order plans are calculated from stored target/policy
  context, not model assertions. Policy revision and target versions are pinned
  for persistence. The exact evaluated context is also compared under catalog
  row locks, so a category change cannot silently reuse an old approval plan.
  Evaluation uses database time and pins the currently effective rule IDs to
  detect rule activation/expiration between evaluation, commit and MCP votes.
  A pending gate is not a committed business action.
- Sealed proposals are read through canonical visibility-aware functions, never
  unrestricted service-role quotation queries. Legacy sales quotation endpoints
  now require a workspace and `purpose=sales`, including child-item reads.
- SQL diagnostics and credentials are not returned in errors. No automatic write
  retries: an interrupted response may represent a committed operation.

## Operational limits

- Invitations record participation eligibility; they do not deliver email.
- Whole-proposal awards only; no invented split awards or direct-adjudication enum.
- Supplier onboarding, policy editing, external supplier submission, evidence
  upload and exception-resolution workflows remain in the existing application.
- Unresolved mandatory evidence/minimum offers block progression. Unsupported
  business-calendar deadlines, sequential relative timing and automatic AI votes
  are not simulated as completed actions.
- Orders still require valid catalog/tax mapping. Free-text proposals may be read
  or considered for award but do not imply a valid order or tax determination.
- Request/tender/approval pagination is bounded. Canonical quotation/order list
  functions expose their latest-100 window, not a complete historical export.
- Receipts record non-stock acceptance, not inventory, accounting or supplier payment.
- Stable idempotency keys apply to quotation imports and receipts. Other creates
  are not generally idempotent: reconcile uncertain outcomes before resubmission.
- MCP approval votes require the captured evaluation context on pending event
  approvals. Historical/UI approvals without that snapshot must be resolved in
  the existing UI. When the snapshot is stale, revise the target/policy through
  the normal workflow before requesting a new approval; repeating `create` with
  the same target/version/policy does not replace the existing approval.
  These added snapshot checks protect the MCP path; this API change does not
  retrofit the application's separate UI approval endpoints.

## Verification

Run `npm run test:procurement` for offline schema, policy, routing, authorization,
error-safety, SQL-bridge and legacy quotation-boundary regressions. Run
`node node_modules/typescript/bin/tsc --noEmit --incremental false` for static checks.
Existing screen-access regressions can also be run with the harness Jest config
and `--testMatch '**/router/__tests__/screen-access.test.ts'`.

The initial implementation was additionally exercised against isolated PostgreSQL
17.11 with the application's canonical procurement migrations: 46 checks covered
requisition approvals, tender publication/invitations, sealed proposal opening,
award/order materialization, receipt idempotency and revoked-initiator rejection.
The local integration harness used synthetic authorization/catalog/storage fixture
dependencies; it was not a production migration rehearsal or external-delivery test.
The checked-in PGlite tests explicitly test the adapter boundary with recording
stubs and should not be mistaken for that complete canonical lifecycle test.