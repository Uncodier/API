# Task creation deduplication

## Deployment order

Apply `supabase/migrations/20261111010000_task_creation_idempotency.sql` **before** deploying the API.
It adds a nullable `creation_key` column and a unique `(site_id, lead_id, creation_key)` index to existing `public` and `app_*` task tables. Include it when provisioning new tenants. Existing records are not modified, merged or deleted. No privileges or RLS policies are relaxed.

The create endpoint deliberately fails closed if the column is missing or persistence fails; do not add a fallback to an unguarded insert. Apply the entire migration atomically: the unique index is essential for concurrency safety.

Applied to linked Makinari project `rnjgeloamtszdjplmqxy` on **2026-11-10 at 23:56:37 UTC**, independently verified at **23:56:45 UTC**. Only `public.tasks` was eligible. Column, valid unique index and exact-source migration history were confirmed; RLS/ACLs and business rows were unchanged. The canonical schema repository and fresh-QA bootstrap contain identical copies. API deployment remains pending; the migration alone does not protect an old endpoint that omits the key.

## Agent behavior

Before creating a task, query the lead's open tasks, including pagination. Compare the underlying issue, not just the title or type. New information about the same pending obligation belongs in `UPDATE_TASK` with the existing ID. A failed lookup is not evidence that no task exists.

Task lookups always read the database; Redis is not used for this decision. Execution metadata `command_id` must not be injected into `GET_TASKS` or unified `tasks action="list"` arguments: it would hide tasks from earlier commands. An explicitly supplied command filter remains supported for intentional queries.

The local Workflows transport unwraps the HTTP `success/data` envelope before applying `GET_TASKS` response mappings. The inner result includes `success`, `tasks` and `pagination`; both full pagination and legacy flattened fields reach the agent. Reused CREATE responses preserve description, notes, owner, dates and conversation so a subsequent UPDATE can retain existing commitments.

Customer Support and Sales `CREATE_TASK` tool schemas require `deduplication_key`: a stable identity for the issue within a site and lead, preferably based on an order/study/reference ID plus the action. The HTTP endpoint keeps it optional for legacy clients. Reuse it across retries, title changes and conversations. Distinct issues require distinct keys. The key is hashed before storage.

## Persistence and notifications

- The unique database index arbitrates concurrent inserts; no process-local lock or cache is used.
- The winning insert returns HTTP 201, `created: true`, and performs workflow dispatch and creation notifications.
- A duplicate returns HTTP 200, `created: false`, `deduplicated: true`, and the existing task. It does not overwrite that task, dispatch workflows, or send creation notifications. The agent must use `UPDATE_TASK` for new information.
- Closed tasks retain their identity: a delayed create retry cannot reopen completed work. A genuinely new occurrence must have a new key.
- Legacy clients without a key use a conservative fingerprint of the submitted content and explicit schedule, excluding generated dates, command IDs and conversation IDs. This protects identical retries, not paraphrased titles. Intentional repeated work with identical content needs a new explicit key.
- Existing tasks with no key are found through the agent's lookup; they are not automatically retrofitted with identities.

There is **no fuzzy automatic merge**: similar titles can refer to different orders or studies. Semantic reuse depends on the agent's lookup and stable issue identity. This is not an exactly-once email outbox: a crash after insertion and before notifications can leave the task without a creation email; retries will not create another task or resend that notification. Direct database callers outside this create endpoint are unchanged.

**Concurrency boundary:** two independently chosen keys for the same underlying issue can still create two rows, even after successful fresh lookups. The unique index is an idempotency guarantee for one shared identity, not a semantic uniqueness guarantee. Do not claim otherwise. Fully resolving that case requires a canonical business issue/reference shared by the callers, or a reviewed transactional issue-resolution service; deriving identity from approximate title matching would incorrectly merge distinct work. These repairs do not change existing key hashes or the applied migration.

## Validation

Run `npm run test:tasks`. Tests execute the actual migration and unique index in PGlite and cover concurrent creates, changed titles with a shared identity, closed-task retries, site/lead isolation, separate issues, legacy retries, fail-closed persistence errors, notification counts and GET_TASKS response mapping/status filters.

Repair regressions also cover stale empty cache entries, updated notes, PostgREST page caps, stable sorting, the real GET HTTP response through local-worker envelope handling, and preserved fields on duplicate CREATE. Executor and voice suites cover injected versus explicit command filters separately.