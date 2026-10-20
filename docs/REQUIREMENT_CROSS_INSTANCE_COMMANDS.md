# Cross-instance requirement commands

## Contract

Several interactive sessions may submit changes, but each requirement keeps its
existing `runner_instance_id`. Command admission never reassigns that runner,
creates a sandbox or starts a second executor.

The assistant route persists the actual user message in `instance_logs` and passes
its `userMessageLogId` through the owned recovery scope. The tool catalog captures
that identity separately from model arguments, text provenance and custom tools.
`requirements action="update"` submits one consolidated patch per requirement per
user message. The host supplies site, actor, source instance and action identity;
the model selects the target and requested changes, not the authorization.

`submit_requirement_command` validates the persisted trusted user action, its
site/user/source instance, current effective access and patch whitelist. It stores
the patch and a requirement-scoped authorization receipt atomically. The original
message remains referenced by its action ID rather than copied from model prose.
A message may address multiple requirements; replaying the same requirement/action
does not overwrite its first patch or create another authorization revision.

## Execution boundary

Commands are queued, not immediately applied. The existing cron claim first drains
eligible pending commands after the source action is finished and the current
execution leases are no longer live. It applies them in order, advances the
requirement generation at that safe boundary and delegates to the existing
scheduler. The same runner/session/workspace continuity rules still apply.

Healthy leases, explicit user holds/pauses, historical completed backlog, budgets
and plan evidence are not cleared by command submission. Paused/cancelled work is
not implicitly authorized to resume by this command path. A missing workspace is
still a separate infrastructure issue: queuing changes does not recreate it.

Interactive requirement mutations through `requirement_backlog`,
`requirement_status`, requirement-bound `instance_plan` and `update_repo` are
redirected to the consolidated command path. Read-only inspection and standalone
plans remain available. Non-interactive runner tools retain their existing path.

Backlog expansion checks requirement-scoped user-action receipts, not the source
instance's equality with the runner. For feedback received during an active cycle,
the command's applied timestamp allows new scope after the old work completes.
The service-only `has_requirement_scope_authorization` RPC excludes unapplied
command receipts, even if their original message is newer than the completed
backlog. Requirement history includes authorized messages from other sessions,
with existing tenant checks and redaction.

## Boundaries

- A status question should use `requirements action="list"`, not submit a patch.
  The assistant route no longer resumes requirements automatically when a message
  arrives, even on the runner's session. The host does not independently infer
  natural-language change intent.
- A queued receipt explicitly says `execution_started: false`; it is not proof of
  delivered work or successful sandbox recovery.
- Interactive patches currently accept title, description, instructions, priority,
  type, budget, cron, cycle, nonterminal start status and pending completion only.
  Ownership metadata, terminal completion, cancellation and pause release are not
  supported by this path. Use existing authorized administrative controls for them.
- Message-authorized remote delegation fails closed; no private authority is
  forwarded as model-authored remote tool parameters.
- Standalone plan edits verify the stored plan's source instance and requirement
  binding. Omitting a model `requirement_id` or supplying another runner's instance
  ID cannot bypass command admission.
- An old recovery receipt cannot first submit a command behind a newer queued or
  applied command. Replays of an already submitted command remain idempotent.

## Rollout and validation

Apply the forward migration at
`/Users/prado/Desktop/Proyectos/Uncodie/Code/API/supabase/migrations/20261020200000_requirement_cross_instance_commands.sql`
before deploying this API. Its RPCs and queue are service-role only. No production
migration, deployment, robot restart or live paid sandbox is performed by the
offline implementation tests.

From `/Users/prado/Desktop/Proyectos/Uncodie/Code/API`, run:

```sh
npm run test:harness -- --runTestsByPath \
  src/app/api/agents/tools/requirements/__tests__/command-authorization.test.ts \
  src/lib/services/__tests__/requirement-cron-reset-concurrency.test.ts
npm run test:harness:agent -- --runTestsByPath \
  src/lib/harness/__tests__/requirement-command-sql.test.ts \
  src/lib/harness/__tests__/requirement-context.test.ts
```

Additional offline regressions cover receipt-based backlog admission and private
assistant context wiring. SQL tests use ephemeral PGlite and synthetic identities;
they verify serial interleavings, not multi-connection production contention.