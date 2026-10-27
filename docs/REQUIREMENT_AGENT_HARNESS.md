# Requirement execution through the canonical assistant

## Active code path

`GET /api/cron/requirements-apps` → `runCronAppsWorkflow` → `executeRequirementCycle`
→ `assistant/requirement-runtime.ts::runRequirementCycle`
→ `assistant/requirement-workspace.ts::executeRequirementAssistantWorkspace`
→ `assistant/requirement-session.ts::runRequirementAssistantSlice`.

The minute cron in `vercel.json` is unchanged. There is no second scheduler,
standalone session API, feature-flag alternative or coordinator/Judge workflow.
The requirement session uses the canonical assistant's `prepareAssistantContext`
and `processAssistantTurn` implementations in `assistant-context.ts` and
`assistant-turn-core.ts`. Interactive durable wrappers (`steps.ts` and
`assistant-turn.ts`) retain their exports and delegate to those same modules.
Requirement execution therefore shares the assistant prompt/context preparation
and turn core rather than maintaining a separate model loop or harness prompt.
Interactive assistant requirement plans still hand off to this cron instead of
executing under a competing owner. Standalone assistant conversations and unrelated
workflow/node execution are not replaced by this change.

The former production harness engine, runtime, model and prompt are retired;
archival test fixtures are not production dependencies. Harness helpers, storage,
workspace safety and tools remain infrastructure, not an alternative executor.
`attachRequirementAssistantHost` attaches trusted requirement tools/context through
a host-only `WeakMap`. These capabilities are not serialized request fields and
cannot be supplied by a user or model as an execution override.

### Existing sessions and retirement safety

The canonical adapter retains the existing session tables, requirement ownership,
workspace identity, transcript and monotonic usage counters. Retirement is not a
new session, a budget reset or a reason to fabricate user actions. Current assistant
activity is written to `instance_logs`. Historical transcript entries remain in the
durable session and are available through `read_session_history`; initialization
does not copy them into the user timeline as system logs. This avoids spending the
cycle deadline on sequential historical audit writes before any work or source
checkpoint can run. The persisted audit cursor advances without changing the
transcript, counters or dispatch-version marker. Previously imported logs are not
deleted or rewritten. Routine cycle/workspace admission stays in runtime diagnostics;
model allocation stays in the durable session counters rather than a system log.
Current assistant/tool receipts and actionable execution errors remain audited.

An idle host `TimeoutError` ends the slice as `waiting` (`runtime_slice_expired`)
and uses the existing cron backoff, not a permanent reconciliation pause. This
only applies to the exact host abort reason with no model in flight, unfinished
tool calls, pending/uncertain effects or unpersisted transcript changes. Storage,
ownership, billing and in-flight operation failures remain fenced. No additional
recovery table, scheduler or retry loop is involved.

The canonical executor must preserve that exact host timeout at model admission
and completed-turn hooks too; wrapping it back into `RecoveryError` would undo
the idle-slice behavior. Connected executor/adapter tests cover this path with
the requirement billing boundary attached and verify zero provider dispatch or
credit reservations. Boundary failures carry only fixed diagnostic codes
(`execution_check_failed`, `session_lease_failed`, `session_save_failed`, or
`boundary_failed`) into the cycle error's `boundary_code`; raw ownership/storage
exceptions are never retained. These codes do not authorize automatic recovery.

Command diagnostics read during the submitting conversation can observe that
same action as unfinished. This is an admission wait until the turn completes,
not proof of a permanent blockage and not a reason to submit duplicate commands.

For the already-paused October 27 incident only, the operator script
`scripts/repair-aed8167c-reconciliation-pause.sql` uses the existing session resume
control. Deploy this API first. The script requires the exact reviewed session
version/generation and completed pending command, rejects uncertain effects and
active/manual fences, and leaves command application and budget admission to cron.
It takes brief table write locks: run in a quiet operator window. It is not a
migration or an automatic recovery policy; any changed evidence aborts the repair.

Incomplete pending tool batches from the retired engine **pause for trusted
reconciliation, not replay**. An absent result is not proof that a remote effect
failed. Do not blindly redispatch old calls, clear uncertain-effect fences or reset
history/counters to make a session runnable. The canonical session uses a durable
per-effect boundary for current execution; it does not rely on replaying an entire
cron slice to recover effects.
Current canonical checkpoints have a separate execution-version marker: interrupted
undispatched calls receive explicit not-executed receipts, while dispatched calls
receive unknown-outcome receipts and write fingerprints remain fenced. Neither is
replayed automatically. This closes the outstanding batch so trusted reconciliation
is reachable on continuation. A saved successful `finish_task` receipt recovers its
completion intent without another model call. An import cursor alone is not a
permission to replay legacy work.
Only an explicit `finish_task` with resolved calls completes the session; a prose
answer alone does not. Ordinary tool results persist a full redacted artifact and
the required result log before their pending effect is cleared. Bounded control
and recovery receipts instead persist inline in the checkpoint and in instance
logs. Their snapshot capacity is checked before execution; they do not reserve
another 1 MiB of artifacts, so a full artifact store cannot prevent inspection,
recovery or an honest partial finish.

Routed results use the canonical assistant's nested-envelope outcome normalization:
successful transport does not turn an inner tool failure into success. Uncertain
write fingerprints bind the actual routed tool name and parsed argument object,
not JSON whitespace, key order or either tool-level `thought_process` field.
Existing transport fingerprints remain stored and acquire equivalent canonical
fences during continuation; this does not reset or replay historical operations.
Completion is deferred until the full `afterTurn` boundary has resolved the batch.
The host checkpoint runs while ownership is still active, before the terminal
session save; saving completion must not invalidate its own checkpoint lease.

Requirement-mode output streaming is disabled so redaction and durable full
per-turn receipts happen before output is published. Interactive assistant
streaming is unchanged; this is not a second inference implementation.

This document describes source changes and rollout requirements only. **No production
migration, deployment, cron activation or historical transcript import has been
applied as part of this retirement work.** The checkpoint instructions below remain
deployment prerequisites, not evidence that a migration has run.

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
status/stop, transcript/result pagination, explicit finish and reconciliation.
The agent discovers repo-specific commands; no language/framework/build command is
required. `apply_patch` uses the schema's create/exact-replace operations.

Optional tools include tenant/database/auth/storage provisioning and inspection,
migration application, local HTTP/API/browser/scenario checks, screenshots and visual
critique, tracking installation, source archive and
host-authorized `platform_key_provision`, `deployment_environment_sync` and
`deployment_create` tools. Preview creation verifies the provider project's linked
GitHub repository and uses the requirement branch; it never promotes production.
The independent `review_work` model route is retired, not an optional second
requirement executor.
Agent-selected Git commit/push remain explicit shell commands with a host-brokered
credential for the bound repository. Saving individual files does not run a build,
deploy a preview or request a Judge verdict. The separate host source-checkpoint
hook below runs at owned cycle boundaries, without changing the agent prompt.

Tool failures never cancel a plan, create a product circuit, quarantine work or
remove editing tools. Historical technical blockers and attempt counters remain
context, not authority. Ambiguous remote writes are different: they are not replayed
without trusted reconciliation. Migration ownership/privilege safety still applies.

`finish_task` records an honest implemented/partial/unable summary. The host projects
completion to `on-review`, not automatic product acceptance or `done`. It does not
require build/push/preview success. Explicit user pause/cancel/holds take precedence.

### Automatic source checkpoints (host infrastructure)

Deploy `20261024010000_requirement_source_checkpoints.sql` before enabling this API
version. At a safe end-of-slice boundary and before a terminal save, the requirement
runtime automatically attempts a bounded source checkpoint with the current session
and requirement leases. It is not a model tool and the prompt is unchanged.
Pending tool batches, cancellation and lost ownership do not authorize a checkpoint.
The hook runs before sandbox cleanup; it does not require tests/build/review success.
An initialization/execution failure is not a safe slice boundary: it does not force
publication from the error handler. Sessions already paused for reconciliation must
be reviewed and explicitly resumed through the existing authorized flow after deploy;
this change neither clears their pause nor retroactively publishes their workspace.

The host reads permitted source from the workspace, checks it with the existing
export policy, and creates a GitHub tree/commit on the host-bound requirement branch.
It does not push local sandbox commit history, execute local Git hooks, rewrite the
index or reset files. First checkpoints can create the bound branch from a verified
remote base. Later checkpoints compare the trusted private local baseline and
current remote state, refusing conflicting edits. Reference updates never force
push and must be confirmed by a read before a saved SHA is reported.
Normal local HEAD advances are accepted only when GitHub verifies their ancestry;
the per-file merge base advances only for files actually changed by that commit.
Unknown/unpushed history and divergent edits still fail closed.

`requirement_source_checkpoints` stores private baseline hashes and the last result;
its fenced RPC checks both the cron generation and the session lease. Confirmed
receipts are also shown in requirement status with an immutable GitHub source URL.
Before updating a GitHub ref, a separate fenced RPC durably stores the expected
commit, parent and candidate baseline. If publishing succeeds but the final receipt
is lost, the next cycle verifies the pending commit against GitHub before capturing
new edits. Failed/unknown receipts retain that intent; confirmed reconciliation
clears it. Failure to prepare an intent prevents ref publication.
Failure/unknown receipts preserve the previous baseline and never change task status,
acceptance, budgets or instructions. A later owned cycle may retry safely; an already
terminal task is not silently restarted merely to retry a failed source backup.

This is bounded UTF-8 source backup, **not** a VM snapshot. Credentials, symlinks,
binary files, dependencies, generated output and integration configuration are
excluded; the receipt reports exclusions. Size/capture/conflict failures are explicit
and leave the sandbox unchanged. There is a 25-second host-hook deadline.
Enumeration is paged in 32-KiB chunks with a whole-stream digest to reject index
changes between pages; more than 1,000 unchanged files no longer suppress a small
checkpoint. Defensive bounds remain: 20,000 paths, 8 MiB per listing, 200 changed
files, 4 MiB captured text and 256 KiB per file.
The last confirmed GitHub SHA is recoverable after sandbox expiration, but automatic creation
of a replacement sandbox from that SHA is not implemented: existing missing-snapshot
checks still fail closed rather than silently discarding uncaptured work.

No deployment API is called by checkpointing. Commit messages contain `[skip ci]`,
which is advisory: configure connected GitHub/Vercel integrations separately if
checkpoint branch pushes must not trigger deployment. Search results that exist only
in `harness_artifacts` are not invented as repository files or final reports.

### Nonblocking requirement execution and public research

Requirement-bound sessions do not expose `wait_for_input`. A stale/persisted call
receives a nonblocking tool error and guidance to continue authorized work or
finish with an honest `partial`/`unable` result. Standalone interactive sessions
retain their wait/resume protocol. Missing input never grants permission to spend,
publish, bypass authorization, or fabricate research evidence.

The forward migration `20261023200000_agent_requirement_nonblocking_wait.sql`
removes the `waiting` → `blocked` projection and permits the same session to resume
after the scheduler backoff, without resetting history, budgets or ownership.
Historical agent-created wait blocks are recovered only with matching durable
cycle provenance, including the same originating database transaction for the
requirement, run mapping and latest status. If any was subsequently edited or
history was pruned, recovery fails closed. Unrelated/manual blocks and explicit
pauses are not mass-cleared.
The recovery predicate is applied before the 1,000-candidate limit, then checked
again under ownership locks. Old unrecoverable wait rows cannot fill the candidate
window and hide ready work. Offline SQL regressions cover 1,000 obstructions ahead
of a genuine recovery and a new pending requirement.
User pause/cancel, security/ownership checks and resource limits remain enforced.

The requirement tool factory now exposes `webSearch`, using the existing public
Azure Bing search adapter and site credit policy. It is independent of the
localhost-only QA browser. Capability discovery lists the search tool; the current
model tool list, not an older transcript, is authoritative. Research deliverables
do not require app edits or deployment merely because a workspace is attached.
Each requirement model turn now receives a live inventory derived from the exact
assembled dispatch list, both in the system instructions and after historical
messages/context compaction. It explicitly distinguishes exposed public webSearch
from the localhost-only QA browser. An old missing-tool receipt cannot be the only
availability guidance on resume. The inventory is ephemeral (no appended durable
messages or fake search receipts), included in token accounting, and grants no new
permissions or proof that the provider is healthy. Actual call results, credit
checks and uncertain-effect protections still apply. A completed `unable` session
is not automatically reopened by this change: deploy first, then use the existing
authorized requirement reopen command to retain its session/history/budgets.
Search checks the bound site/user/runner/generation and active leases before paid
work. It uses durable write checkpoints because searches consume credits; uncertain
billing/provider effects cannot be replayed as if they were free reads. Credentials
stay host-side and public source text remains untrusted reference material.
The host adapter validates and normalizes query arguments before the execution
boundary hashes or dispatches them. Leading/trailing whitespace cannot create a
different replay identity for the same paid search. Resuming older sessions adds canonical fences
for uncertain/pending raw-argument calls without removing their original fences.

For this repair, drain the requirement workers, deploy the updated API and apply
the forward migration before re-enabling the cron. It requires
`20261020200000_requirement_cross_instance_commands.sql` and preserves that
migration's public command-draining wrapper. Do not enable recovery while
old workers still lack search and still issue agent waits. No live search,
production migration or deployment is implied by the offline tests.

### Progress without repetition gates

`requirement_progress` accepts an explicit optional `target`:

- `step`: `planId`, `stepId`, and optionally its linked `itemId`.
- `item`: `itemId`, with no plan or step selector.
- `plan`: `planId`. This updates only the plan itself; leftover step/item selectors
  are ignored and reported, rather than creating a validation/retry loop.
- `message`: a progress message without a status mutation.

Legacy calls without `target` retain their existing meaning. Completing a step
does not automatically close its plan. Explicit plan completion does not require
passing tests or completing every step, and does not implicitly finish the task.
The agent chooses when to call `finish_task` with an honest outcome.
Explicit `item` and `message` targets likewise ignore irrelevant selectors;
`requirement_context` follows its explicit view. The selected target still needs
valid IDs and host ownership. Ignored selectors never cause additional writes.

The forward progress-receipt migration compares statuses while holding the same
ownership/row locks. Repeating a recorded status succeeds with `unchanged`, does
not rewrite that progress or bump its revision, and still records a supplied
message. It returns actual plan/step/item statuses and full-array counts. Tool
responses distinguish that no-op from a change and explain how to select another
target. They do not block repeated calls, remove tools, or force completion.

The initial cycle snapshot is historical context, not a repeatedly appended claim
of current state. A compact scoped status refresh is advisory; its failure is
reported as unavailable rather than treating stale information as fresh or
blocking ordinary tools. Context copies are not accumulated in the transcript.

Rollout order for this repair: deploy the API that understands `unchanged` first,
then apply `20261014195500_agent_progress_receipts.sql`. The new API tolerates an
old basic receipt but explicitly reports current state unavailable. Do not apply
the new RPC response contract while old workers are still handling progress.
Keep the previous exhausted canary transcript and counters intact; use a new
explicitly scoped canary after both changes are verified, rather than resetting
its budget/history. Local tests alone do not demonstrate a production repair.

### Operational safeguards

- Same-site/user/runner/generation checks and cron leases gate every model/effect;
  the session also has its own CAS version and lease token. No ownership-read fallback.
- Host runtime configuration is encrypted separately from transcripts. Credentials
  are redacted before persistence/results; control-plane secrets never enter command
  environments. Runtime commands explicitly opt into scoped application environment.
- Account-credit admission remains the per-operation consumption gate for canonical requirements.
  Historical `request.limits` fields remain in persisted snapshots for compatibility
  but no longer cap turns, cumulative allocation, active time or model output.
  Counters remain monotonic telemetry; `allocatedTokens` is a legacy byte-based
  allocation counter, not provider token usage. Output configuration uses the shared
  executor's existing request settings and provider safeguards. Transport deadlines,
  storage bounds, ownership, explicit pauses and uncertain-effect fences still apply.
  Counters are never reset. Most existing pauses require authorized recovery;
  the narrowly scoped economic reevaluation below can resume verified
  `token_budget_exhausted` and classified pre-dispatch `account_credits_exhausted`
  pauses without a new user message.
- At the start of each cron cycle, before profile/workspace/model work,
  `evaluate_requirement_cycle_budget` sums existing customer charges attributable
  to the requirement across its sessions. `budget` is USD-equivalent credits
  (1 credit = 1 USD); null disables this additional check, zero permits no spend.
  Settled model charges come from their reservation ledger, tool debits/refunds
  are netted once, and registered requirement VM charges come from reconciled
  provider-session billing. Model holds/refunds and sandbox ledger entries are
  excluded from the tool sum to avoid double counting.
  If charged spend is at least the budget, the existing cycle-finishing RPC blocks
  the requirement with `token_budget_exhausted` and an explicitly monetary summary.
  This is NOT a reservation or hard spending cap: a cycle can overshoot, pending
  model costs and not-yet-reconciled VM time are not settled spend. Existing account
  billing/uncertain-effect protections still apply. Raising the budget does not
  authorize clearing unrelated pauses or holds.
  Apply `20261026010000_requirement_cycle_budget.sql` before deploying this API;
  missing/failed accounting prevents cycle execution rather than assuming zero.
  Deploy `20261026020000_requirement_economic_recovery.sql` after the cycle-budget
  migration and its indexes to enable economic reevaluation in the existing claim
  RPC. Before command draining and normal admission, a rotating batch of at most
  100 recorded economic pauses is checked (at most once per minute per pause).
  A requirement must have both remaining monetary budget (or null/unlimited)
  and positive usable account credits after the existing credit-period renewal.
  This is a preflight, not a reservation or a guarantee that the next model hold
  fits; normal pre-dispatch credit admission still applies. Buying credits cannot
  bypass an exhausted requirement budget, and raising its budget creates no credits.
  Classified `account_credits_exhausted` pauses additionally retain the rejected
  reservation amount in the trusted session snapshot. Recovery requires enough
  usable credits for that amount, not merely a positive balance; missing or invalid
  admission evidence stays blocked. This prevents repeated workspace restarts on
  an unchanged insufficient balance. The next dispatch still reserves normally.
  Automatic economic recovery preserves the session, generation, transcript, workspace and counters
  and writes an `economic-recovery:` status receipt. It does not fabricate a user
  action. Direct budget-only edits are recognized; arbitrary edits, later status
  writes (even blocked-to-blocked), session controls/version changes, holds,
  paused runners/plans, live leases, pending model charges and uncertain or
  unfinished tool effects prevent recovery. Sandbox cleanup fences (including
  other sessions referencing the same requirement/resource) also prevent recovery.
  Each recovery runs inside a database subtransaction: a late lifecycle guard or
  failed audit write rolls back the session, requirement and run changes together
  without aborting unrelated cron admission. A private `last_error_code` stores
  only SQLSTATE for failed attempts, never provider error text or credentials.
  Historical import requires matching
  same-transaction cycle/status provenance; edited/unverifiable historical rows
  still need explicit operator recovery. With
  `20261026030000_requirement_pause_recovery_commands.sql`, queued assistant
  commands no longer invalidate provenance merely by advancing authorization:
  every intervening revision must match an unapplied trusted command receipt.
  All pending actions must finish before recovery. Their consolidated budget
  (including an explicitly requested null/unlimited budget) is evaluated and the
  command is applied atomically with recovery; a failed status/audit write rolls
  back the budget, command receipt and session together. Other row edits remain
  fenced. Retired `turn_budget_exhausted` and `active_time_budget_exhausted` pauses
  require a new trusted command after the pause, plus all economic/effect checks;
  counters and history are retained. Historical import is restricted to intact
  same-transaction provenance, not inferred from free-form error messages.
  Applying a queued command increments the execution generation once, as ordinary
  command application does. A non-economic session explicitly resumed through
  the authorized session control may accept its queued command despite an old
  mapping pause reason; commands alone never clear an active manual pause.
  A command queued before installation may have changed the requirement's row
  transaction identity, preventing historical import. Such unverifiable historical
  rows report `economic_provenance_unavailable`; another queued message alone
  cannot reconstruct the missing historical evidence. The forward migration
  `20261027010000_requirement_command_pause_import.sql` provides a one-time bridge
  for completed trusted command chains after such a historical pause. It requires
  matching original mapping/status transaction identities, a current requirement
  row written in the newest pending command transaction, contiguous admitted
  revisions with authorization receipts, and a matching paused same-user session.
  It captures current state as a new recovery baseline, not as proof that every
  earlier requirement row was unchanged. It never resumes or applies commands:
  normal recovery still checks manual pauses, leases, effects, accounting and
  credits. Rows without this evidence still require operator review. Deploy after
  the two October 26 command/recovery migrations; existing provenance is not replaced.
  Ambiguous billing errors, reconciliation pauses, provider authorization failures,
  user pauses and other exhausted limits are deliberately not auto-recovered.
  `20261026030100_requirement_command_diagnostics.sql` adds service-only, tenant-
  scoped read-only diagnostics to requirement update receipts and list results.
  A command can be applied without execution having started; queued/blocked
  responses explain the observed prerequisite rather than promising a restart.
  Missing diagnostics deployments report unavailable, not successful execution.
  Deploy the cycle-budget/index/economic-recovery migrations first, then these
  two forward migrations, and then the API. No production data is changed by
  the offline regression suite.
  In-process tool charges through CreditService/OpenRouter inherit private host
  requirement attribution. Historical untagged charges and separate HTTP media
  billing without requirement attribution cannot be safely assigned to this total;
  they are not guessed from shared site/instance activity. No retrospective charge
  or production migration is performed by the offline tests.
- Cycle aggregation uses disjoint `UNION ALL` branches for explicit requirement
  and session attribution, preserving duplicate-valued transactions while counting
  dual-attributed transactions once. Session IDs remain text on the ledger side;
  an explicit requirement ID takes precedence over legacy session attribution,
  including conflicting IDs, so one charge cannot belong to two requirements.
  malformed historical metadata cannot fail a UUID cast. The cost remains linear
  in the requirement's own history, not constant-time or a cached balance.
  Apply `20261026010100_requirement_budget_indexes.sql` before enabling the cycle
  check on large datasets. The migration uses transaction-safe `CREATE INDEX` and
  can run as one SQL Editor batch or inside a migration transaction. It does not
  rewrite tables, but blocks writes on affected tables until the transaction ends;
  schedule a maintenance window. For an online rollout, prebuild the same indexes
  by changing each `CREATE INDEX IF NOT EXISTS` to
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS` and executing each statement separately
  outside transactions (one autocommit request per index, never the entire batch).
  Verify all six indexes are valid and ready before applying the migration, which
  then skips existing indexes. `IF NOT EXISTS` does not repair an invalid index
  left by a failed concurrent build. These indexes
  cover requirement model charges, both ledger attribution paths, requirement
  sessions and sandbox ownership/charges. Ownership locks remain unchanged.
  Offline tests run the real aggregation expressions with `EXPLAIN ANALYZE` on
  synthetic same-site history, assert indexed access without global sequential
  scans and verify unchanged totals/refunds. Timings are diagnostic, not brittle
  test thresholds or production performance claims.
- Canonical requirement model calls retain the existing idempotent
  hold/dispatch/settle ledger. A conservative pre-dispatch credit hold is settled
  against validated actual provider `usage.cost` using the existing pricing
  conversion, releasing unused held credit rather than treating the estimate as
  the final charge. Session/event identities prevent double charging on ledger
  retries; inference is never replayed merely to recover a hold. Canonical boundary
  billing replaces, rather than adds to, the executor's default model charge.
  Missing or invalid cost leaves the hold unresolved and raises a billing error;
  it is not reported as free usage. Settlement remains required for paid inference
  even if ownership is subsequently paused. Pre-dispatch cancellation and verified
  admission rejection use the existing cancellation path. These are source-level
  contracts, not evidence of a production ledger migration or billing reconciliation.
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