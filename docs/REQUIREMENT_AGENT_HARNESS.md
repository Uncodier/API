# Requirement agent harness

## Active code path

`GET /api/cron/requirements-apps` → `runCronAppsWorkflow` → `executeRequirementCycle`
→ `runRequirementCycle` → `executeSessionSlice` → `runSessionSlice`.

The minute cron in `vercel.json` is unchanged. There is no second scheduler,
standalone session API, feature-flag alternative or coordinator/Judge workflow.
The former portable core is now the executor used by the normal requirement cron.
Interactive assistant requirement plans still hand off to this cron instead of
executing under a competing owner. Standalone assistant conversations and unrelated
workflow/node execution are not replaced by this change.

### Product context and continuity

- The host selects existing requirements, respects recurring schedules, and binds
  one durable session and runner to each requirement occurrence.
- Requirement instructions, backlog/acceptance, owned plans and recent history
  enter the agent context. `requirement_context` reads additional pages.
- `requirement_progress` records existing item/step/plan progress. `requirement_plan`
  optionally creates or extends a plan. A plan is not required to edit source.
- Native model messages, tool receipts, provider reasoning and workspace identity
  persist across cron ticks. A failed validation returns to the same agent with
  the same editing/command tools. Narrative replies do not prematurely end a task.
- Fresh context is attached to each cycle; it does not replace the transcript.
  `read_session_history` and `read_result_artifact` expose older/full evidence.
- A cycle has a transport deadline, not a one-tool/five-turn product gate. The
  next minute resumes the same session. There is no perpetual workflow loop.
- Existing workspace adoption preserves dirty files and the branch. It verifies
  the repository and owner and never resets to origin or silently substitutes a
  clean VM when a snapshot is unavailable. A new clone uses the requirement branch.

### Tools, not administrative gates

Core: `read_files`, `list_files`, `search`, `apply_patch`, `exec`, background process
status/stop, transcript/result pagination, explicit finish/wait and reconciliation.
The agent discovers repo-specific commands; no language/framework/build command is
required. `apply_patch` uses the schema's create/exact-replace operations.

Optional tools include tenant/database/auth/storage provisioning and inspection,
migration application, local HTTP/API/browser/scenario checks, screenshots and visual
critique, tracking installation, source archive, independent `review_work` and
host-authorized `platform_key_provision`, `deployment_environment_sync` and
`deployment_create` tools. Preview creation verifies the provider project's linked
GitHub repository and uses the requirement branch; it never promotes production.
Git commit/push are explicit shell commands
with a host-brokered credential for the bound repository. Saving files does not run
a build, push a checkpoint, deploy a preview or request a Judge verdict.

Tool failures never cancel a plan, create a product circuit, quarantine work or
remove editing tools. Historical technical blockers and attempt counters remain
context, not authority. Ambiguous remote writes are different: they are not replayed
without trusted reconciliation. Migration ownership/privilege safety still applies.

`finish_task` records an honest implemented/partial/unable summary. The host projects
completion to `on-review`, not automatic product acceptance or `done`. It does not
require build/push/preview success. Explicit user pause/cancel/holds take precedence.

### Operational safeguards

- Same-site/user/runner/generation checks and cron leases gate every model/effect;
  the session also has its own CAS version and lease token. No ownership-read fallback.
- Host runtime configuration is encrypted separately from transcripts. Credentials
  are redacted before persistence/results; control-plane secrets never enter command
  environments. Runtime commands explicitly opt into scoped application environment.
- Session limits are monotonic: 500 model turns, 10M allocated tokens, four active
  hours per occurrence. Model output allowance is 4096 tokens per request. Deployment
  operators should review these cost limits before enabling cron.
- Model calls reserve site credits before dispatch through an idempotent ledger RPC.
  Current reservation is conservative (UTF-8 input upper bound + maximum output);
  unused reservation is not settled/refunded. This is intentionally disclosed, not
  equivalent to exact-token billing. Billing failure pauses instead of free-running.
- Missing credentials/services are reported without invoking product repair controllers.
  Known transient model/runtime/dispatch failures retry the same session after a delay.
- Provider 401/402/403 admission failures pause for operator intervention rather
  than spending every cron tick on the same rejected request.
- Workspace-open 401/403 and 402 responses now retain a static authorization or
  provider-billing classification and pause before model dispatch. Transient
  setup failures remain retryable. This repair requires deployment; it does not
  retroactively identify the HTTP cause of old generic workspace-open failures.
- SDK OIDC-context failures have no HTTP response. These now receive the separate
  `WORKSPACE_AUTH_CONFIGURATION_REQUIRED` classification and pause without printing
  SDK exception text or its nested cause. Other HTTP setup errors retain a numeric
  status in static diagnostic messages, without exposing response bodies.
- Workspace failures include a `workspace-v1` diagnostic identifying `get`,
  `create`, network-policy/tag updates, adoption updates or bootstrap. The installed
  SDK's `json.error` is inspected only for allowlisted codes, field names and
  validation rules (for example `networkPolicy`, `ipv4`, `pattern`, `maxLength`).
  Unrecognized details remain `unclassified`; no raw message, field value, request
  body, URL, header, credential or nested SDK cause is persisted. HTTP 400 alone
  does not establish an authentication failure or authorize recreating a workspace.
  Field/rule labels are lexical hints, not proof of a rejected constraint. SDK
  network-policy updates can issue multiple HTTP requests; the operation label
  identifies the SDK call, not an independently verified failing endpoint.
- Tool result storage is bounded; full redacted artifacts are durable before their
  references are saved. Pending operations are stored before dispatch. Ambiguous
  writes require trusted adapter receipts/idempotency, not a model's assertion.

### IPv4 workload isolation and current image bootstrap

The live Sandbox API rejects IPv6 deny CIDRs (including `::/128`), despite generic
CIDR types in SDK 3.2.1. The harness retains all fourteen IPv4 private, metadata,
reserved and multicast deny ranges. Every workload command additionally runs
through an inline trusted Linux launcher: seccomp is installed before switching
from root to dedicated UID/GID 1001, all capability sets are cleared, and
`no_new_privs` is enforced. IPv6 (including mapped IPv4), raw packet/netlink sockets,
named Unix sockets, cross-process tracing and io_uring are unavailable. Anonymous
Unix socketpairs and IPv4 remain usable. Filters survive exec/fork and cannot be
removed by the workload; failure to install them never runs an unguarded command.

Credential-broker TLS termination is outside the guest. It is therefore restricted
to the public `github.com` origin, with `Host` pinned on every broker request and
credentials restricted to the exact repository's Git endpoints. There is no
arbitrary `forwardURL` or credentialed custom-host fallback. Ordinary HTTPS still
uses IPv4 connections and the provider's deny ranges. This does not assert the
provider itself is IPv4-only.

New trusted images initialize the previously absent `/vercel/sandbox` directory
without replacing files or following symlinks. Only after initialization does the
host save `harnessIsolation=ipv4-process-v1`. Old untagged workspaces are preserved
and paused for an explicit host migration, not reset or silently relabelled.
Image/runtime changes that cannot satisfy the launcher fail closed. System package
installation via sudo, privileged containers, IPv6-only services and named Unix
sockets are deliberately unsupported in workload commands. Browser system
dependencies must be present in the trusted image; installation is not exempted.
Legacy helper file IO also runs under UID 1001, restricted to the workspace and
fixed probe/screenshot scratch paths with no-follow descriptors and a 256 KiB cap.
Recursive scratch cleanup is refused; oversized screenshots fail explicitly.
These operational limitations are not a claim that all optional browser/QA tools
have passed production canaries.

## Deployment is a separate operation

This code change does **not** apply migrations, deploy API code, activate production
cron or demonstrate a live staging run. Before rollout:

1. Disable/drain existing requirement cron workers and assistant requirement effects.
   Wait for in-flight durable legacy workflows and leases; do not run old and new
   deployments concurrently against the same requirement owner.
2. Back up and apply forward migrations in order:
   `20261014010000_portable_harness_sessions.sql`,
   `20261014020000_portable_harness_host_state.sql`,
   `20261014030000_agent_driven_requirement_cron.sql`,
   `20261014040000_agent_requirement_progress.sql`,
   `20261014050000_agent_requirement_credit_reservation.sql`.
   The first two names describe the reused storage implementation, not a parallel API.
3. Verify existing encryption, Supabase admin, OpenRouter and sandbox configuration
   in the host. Requirement metadata/site configuration supply the repository and
   capabilities; no `HARNESS_V2_ENABLED` switch or manual V2 profile is needed.
4. Deploy, then run staging with a scoped test repository and funded test tenant:
   existing requirement+backlog+plan → edit → failed validation → correction →
   progress → next cron tick on the same session. Inspect status, session, credits,
   workspace and full redacted receipts. Exercise user pause and expired ownership.
5. Enable the existing cron only after the live staging checks pass.

### Sandbox authentication is distinct from deployment credentials

The installed `@vercel/sandbox` SDK does **not** automatically use `VERCEL_TOKEN`.
Its default is OIDC from the Vercel request context or `VERCEL_OIDC_TOKEN`.
The harness preserves that default (`HARNESS_SANDBOX_AUTH=oidc` or unset).

For an explicitly chosen access-token host, set `HARNESS_SANDBOX_AUTH=access-token`
and all three `HARNESS_SANDBOX_TOKEN`, `HARNESS_SANDBOX_TEAM_ID`,
`HARNESS_SANDBOX_PROJECT_ID`. In this mode only, corresponding `VERCEL_TOKEN`,
`VERCEL_TEAM_ID`, `VERCEL_PROJECT_ID` values are supported as fallback configuration
names. Missing/invalid values fail closed; no login, automatic auth fallback or
default-project creation is attempted by the harness resolver. The app deployment
project (`APPS_VERCEL_PROJECT_ID`) is deliberately not a sandbox-project fallback.

The resolved credentials are passed consistently to lookup, creation, workspace
adoption and optional-tool reconnection. They are not written into the session,
model tool arguments or the VM environment. An unauthorized token still returns
403; selecting access-token mode does not grant access to another team/project.

Offline SDK contract tests reproduce a non-HTTP `VercelOidcContextError` and prove
explicit credentials reach a fake provider request. This establishes the SDK
contract, not which authentication error occurred in a past deployed execution.

Old shared gate modules remain where still imported by independent tools/tests and
other workflows. The old requirement orchestration workflow and parallel session
API were removed, not retained as a fallback. Rolling back code requires draining the
new executor first; do not let an old deployment reclaim an active new session.

## Offline verification

With Node 22:

```sh
npm run test:harness:agent
npm run test:harness
node node_modules/typescript/bin/tsc --noEmit --incremental false
git diff --check
```

Tests use mocked provider boundaries, real local Git/filesystem checks and ephemeral
PGlite for the forward SQL. These tests are not a live Vercel/Supabase/OpenRouter E2E,
and single-process PGlite is not multi-connection contention testing. Source-contract
tests that mandated the removed coordinator/gates were replaced with checks of the
new active entrypoint. Unrelated legacy capability and security coverage is retained.

### Known limits requiring rollout review

- Private non-GitHub repositories need a host credential integration; the existing
  GitHub credential is not sent to other repository hosts. Public HTTPS repositories
  do not require a manual profile.
- Generic standalone assistant plan execution retains its own workflow. This change
  replaces requirement execution, including assistant-to-requirement handoff, not
  every autonomous workflow in the product.
- An ambiguous remote credential creation may leave an orphaned test-only key if
  host persistence fails after issuance. It is reported, not automatically replayed.
- Source archives are bounded text exports, not complete binary backups.
- Backlog/plan pagination bounds model output, but the existing embedded JSON DB
  columns must still be loaded before slicing. Very large rows need future storage work.