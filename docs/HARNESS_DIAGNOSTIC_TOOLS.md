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

### Interpreting `sandbox_tools_exposed=false`

`harness_inspect.runtime` describes **only the current invocation**, not every
worker on the instance or the platform. Its `scope` is `current_invocation` and
its `observation` is `exposed_tool_manifest`:

- `sandbox_tools_exposed=false`: no name in that manifest starts with `sandbox_`.
  Do not turn this into a global execution blocker or permanent worker incapability.
- `sandbox_tools_exposed=true`: at least one such tool is exposed. This does not
  establish that a write/migrate tool is available, the sandbox is healthy, or the
  requested operation is authorized. Restricted evidence collection can expose
  read tools without write tools.
- `sandbox_health=not_probed`, `runner_provisioning=not_observed` and
  `other_worker_capabilities=unknown`: this inspection did not test these facts.
  They do not mean provisioning was never attempted, failed, or succeeded.

The manifest is refreshed after tool routing/restriction; diagnostics neither add
tools nor infer them from a skill, `requires_sandbox`, a running instance row or a
saved plan. Another invocation on the same instance can expose a different set.
Chat/coordinator turns may lack sandbox tools, but the sandbox-backed cron
orchestrator does supply them. A role label alone is not an exposure rule.

The bounded migration diagnostic is an important counterexample: its host receives
a sandbox and exposes a restricted `migration_read_context` reader, while the
model receives no general `sandbox_*` tools. Its false flag is accurate; treating
it as proof that the runner cannot execute is not.

### Check the execution boundary, not just the local tools

Continue with the diagnostic tools actually exposed. Identify the responsible
runner, requirement, plan/step and current generation. Use `harness_events` for
scoped dispatch, sandbox creation/reattachment and operation evidence, and
`harness_reference` topics `runtime`/`capabilities` for the implementation map:

| Boundary | Implementation and checks |
| --- | --- |
| Requirement admission | `src/app/api/cron/requirements-apps/workflow.ts` checks admission/preflight before sandbox creation; a hold is not a provisioning attempt. |
| Requirement sandbox | `src/app/api/cron/shared/cron-sandbox-lifecycle-steps.ts` tries named/stored sandbox reuse, then `SandboxService.createRequirementSandbox`, with execution-ownership checks. |
| Step execution | `src/app/api/cron/shared/single-turn-executor.ts` checks ownership and persisted step generation, calls `connectOrRecreateRequirementSandbox`, then assembles, guards and restricts `getSandboxTools`. Attach failures return a transient sandbox infrastructure wait, not a tool-manifest-based permanent failure. |
| Reattachment/recovery | `src/lib/services/sandbox-recovery.ts` checks workspace readiness, handles warm recovery and VM replacement. It does not consume the chat's diagnostic boolean. |
| Cron orchestrator | `src/app/api/cron/shared/cron-orchestrator-step.ts` connects the sandbox before supplying its tools. |
| Reusable workflow | `src/lib/services/workflow-robot/run-plan.ts` conditionally calls `ensureWorkflowSandbox` in `sandbox-workspace.ts` for sandbox/browser steps. Pre-response runs prohibit these steps. |
| Bounded migration diagnosis | `src/lib/services/apps-platform/migration-diagnostic-agent.ts` retains sandbox access in a host-bound reader without giving the model general sandbox tools or SQL approval. |

These source references explain provisioning logic; they do not prove a live
worker was dispatched or a provider operation succeeded. Report an observed
provisioning failure with its scoped evidence and next check. Missing evidence is
unknown, not a permanent failure or proof of recovery. Do not auto-expose tools,
invent calls, launch a replacement worker, change ownership, reset budgets or
bypass a hold to test availability. Provisioning/recovery defects need a separate
execution-layer fix, not a diagnostic override.

Migration lifecycle states/reasons also have a limited meaning. A reason such as
“a pending migration has no requirement-bound implementation plan” does not prove
sensitive SQL was detected or that the migration was already applied. Verify the
recorded security review, protected application receipts and fresh validation
separately. The inspection preserves the actual hold and reason; uncertainty is
not permission to rewrite applied history or release a hold.

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

Invocation-local diagnostic regression verification (Node 22):

- Focused harness diagnostics/reference, migration diagnostic, sandbox lifecycle,
  single-turn ownership and sandbox fast-attach suites: **6 suites / 151 tests passed**.
- `npm run test:harness`: **163 suites / 2,308 tests passed** on the shared worktree.
- New assertions cover false flags across runtime labels, read-only/partial sandbox
  tool exposure, different invocations on the same instance, manifest refresh after
  restrictions, unchanged holds/no writes, prompt guidance and allowlisted sources.

This verifies offline contracts, not live sandbox provisioning, deployment or
release of existing holds. No tool-exposure or execution-policy change is made by
the diagnostic correction.

Historical validation for the original diagnostic-tool implementation: 157 harness
suites / 2,110 tests passed. Focused
TypeScript checking of the new diagnostic modules and migration diagnostic agent
reported no errors. Whole-repository type checking still reports unrelated errors;
Next is configured to skip that check during build. Tests do not certify deployment.
`next build --webpack` completed with existing deprecation/dependency warnings.
Both the assistant and durable step `.nft.json` manifests contain all 30 allowlisted
source files; source availability was checked in the generated build traces.