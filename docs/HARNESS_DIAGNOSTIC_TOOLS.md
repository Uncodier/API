# Harness diagnostic and decision tools

The existing requirement assistant and migration diagnostic agent can investigate
the host harness rather than infer platform state from skills or local tool gaps.
This is a tool surface, not another judge or a replacement execution engine.

## Tools

- `harness_inspect`: current requirement, backlog, plans, associated instances,
  migration holds/diagnoses, recent decisions, and the tools exposed to this
  invocation. Includes observation time, state versions and explicit unknowns.
  Multiple reads are not an atomic snapshot. Large views are marked truncated;
  request a specific item or follow backlog pagination.
- `harness_events`: paginated redacted list/read across instances with explicit
  references to the authorized requirement. Conflicting references are excluded.
  Unscoped legacy logs are not proof of absence and remain accessible through the
  existing current-instance history reader. Logged claims are not authority.
- `harness_reference`: architecture, state/tool semantics, recovery boundaries and
  links into the source allowlist. Available without a database or sandbox call.
- `harness_source`: bounded literal search and paginated line reads of allowlisted
  host source. No customer files, shell, credentials or source writes. Revision is
  the server build SHA if configured; it does not prove database migration state.
- `harness_decide`: evidence-backed agent choice, with a stable request UUID and
  the exact `updated_at`/`backlog_revision` obtained by inspection:
  - `approve_backlog`: records approval of the approach, **not completion**, a
    worker start, acceptance-test success, or release of a technical hold.
  - `adapt_backlog`: stores an implementation strategy on the same item, with an
    ordered mapping covering every original acceptance criterion. The
    tool input uses zero-based `criterion_index`; the server resolves the exact
    canonical text, so redacted private content need not be repeated by the model.
    The normal executor receives it as implementation context. Acceptance, constraints,
    dependencies, tier, scope, attempts and verification obligations are unchanged.
    A precisely linked owner/origin plan may be updated atomically only when its
    status and every step are still pending. Active/mixed/manual-paused plans are
    not overwritten. Cancelled/blocked plans are not reopened by adaptation.
  - `escalate_support`: persists a technical ticket with impact, alternatives tried,
    scoped evidence IDs and a specific requested intervention. Delivery is reported
    separately; no generic customer approval is requested.

## Integration and safety

Tools are bound by server closures to the site, instance and requirement. There
are no model-selectable tenant/instance overrides. Only the owner/origin can
author implementation; an explicitly linked instance can report support. Database
RPC checks repeat scope, current state, authority and evidence validation.

Direct diagnostic reads remain exposed in restricted evidence collection;
`harness_decide` does not. The migration diagnostic has 12 model turns, at most
8 project-source reads and 16 harness calls. This changes investigation headroom,
not the historical assignment/application budget or one-diagnostic receipt.
No new automatic background task is scheduled by these tools.

No decision grants SQL approval, edits applied migrations, disables RLS, releases
quarantine/technical holds, resets budgets, changes requirement status or launches
a worker. Rejected decisions are not instructions to bypass guards. A new plan
or claimed capability is not evidence of recovery. These tools make decisions
inspectable; they do not repair every existing execution-state deadlock.

## Technical support delivery

Configure `HARNESS_SUPPORT_EMAIL` to the platform operator's inbox. Existing
`UNCODIE_SUPPORT_EMAIL` or `SUPPORT_EMAIL` is used as fallback. No address is
guessed and no model-supplied recipient is accepted. The decision row ID is the
ticket ID; persisted tickets are visible in `harness_inspect.recent_decisions`.

Email uses the existing SendGrid service. Delivery is claimed with a database CAS
before sending. An interrupted `sending` outcome is uncertain and is **not**
automatically resent. Failed/unconfigured delivery must not be described as sent.
Missing support configuration still allows the ticket to be recorded.
Missing SendGrid configuration is detected before claiming delivery, allowing
the same ticket to be sent after configuration without retrying uncertain sends.
Another request ID cannot create a second support ticket for the same item and
observed requirement state; reuse the existing receipt in `recent_decisions`.

## Deployment

Apply the new forward migration to the **Makinari** database before deploying:

`/Users/prado/Desktop/Proyectos/Uncodie/Code/API/supabase/migrations/20261001220000_harness_diagnostic_decisions.sql`

It creates service-only decision receipts and a constrained RPC. It does not
rewrite existing migrations or reconcile historical customer state. Next file
tracing includes the exact source allowlist in server workflow/assistant bundles.
Missing bundled source is reported as unavailable, never fetched from an arbitrary
repository. Deploy through the ordinary release process; this change alone does
not reopen the Crowdrage instance.

## Validation

`npm run test:harness` includes diagnostic scope/visibility, cross-instance events,
source traversal/redaction/limits, direct-tool routing, support delivery claims,
model diagnostic integration, and PGlite permission/CAS/idempotency/contract tests.
PGlite tests do not prove production multi-connection concurrency or email delivery.
No live model inference, customer SQL application or support email is used by tests.

Local validation for this change: 157 harness suites / 2,110 tests passed. Focused
TypeScript checking of the new diagnostic modules and migration diagnostic agent
reported no errors. Whole-repository type checking still reports unrelated errors;
Next is configured to skip that check during build. Tests do not certify deployment.
`next build --webpack` completed with existing deprecation/dependency warnings.
Both the assistant and durable step `.nft.json` manifests contain all 30 allowlisted
source files; source availability was checked in the generated build traces.