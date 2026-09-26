# Instance context: manual database setup

The source of truth is the migrations at
`supabase/migrations/20260926000000_instance_context_memory.sql` and
`supabase/migrations/20260926030000_instance_context_output_reserve.sql`,
followed by `supabase/migrations/20260926040000_instance_context_output_tokens_repair.sql`.
After those, apply `supabase/migrations/20260926050000_instance_context_input_breakdown.sql`
to enable the estimated category chart for subsequent turns. This migration
adds a numeric-only `input_breakdown` and a service-only RPC; it preserves all
older measurements and does not retroactively reconstruct their categories.
After inspecting the target project and schema, apply
`supabase/migrations/20260926060000_instance_context_unknown_output_and_legacy_reserve.sql`
to store unknown completion counts as NULL and invalidate stale output reserves
when a legacy usage RPC writes a newer checkpoint. Do not apply migrations to a
remote project without verifying its existing schema and migration history.
The third migration repairs databases where the existing state table lacks
`output_tokens`. Inspect the target schema before applying anything. If the
state table and RPCs already exist, **do not rerun their CREATE TABLE statements**:
apply only the missing repair manually to the intended Supabase project. On
databases without the feature, apply the first two in order, then the repair.
The second migration records the model-specific output reserve used
by the widget. Old measurements remain nullable and use a legacy fallback until
the next turn; the revised writer and reader can temporarily run against the
previous schema during a rolling deploy. Do
not run the similarly named `site_skills_catalog` migration as part of this
feature unless that separate feature requires it. Check the project's applied
migrations first; do not run the same `CREATE TABLE` statements twice. The
migration expects `pgvector` (`vector(1536)` and HNSW) and the existing
`public.current_user_site_role(uuid)` authorization function.
It enables pgvector in `extensions` only when not already installed; confirm
the existing extension's schema before running it. The SQL test using PGlite
substitutes pgvector, so the real HNSW index still needs validation in Supabase.

## Configuration (API server, server-side only)

- Published exact IDs receive their documented maximum: Gemini
  `gemini-3.1-pro-preview` (and `-customtools`) **1,048,576 input** tokens,
  OpenAI `gpt-4o` **128,000 total** (16,384 output reserve), OpenAI direct
  `gpt-5.2` **400,000 total** (128,000 output reserve), xAI `grok-4.6`
  **500,000 total**. Azure deployment names, including `gpt-4o`, are unverified
  until configured explicitly. Gemini metadata for other exact IDs is fetched via
  `models.get` with a 2.5s timeout and cached in-process.
  Provider references: [Gemini 3.1 Pro](https://ai.google.dev/gemini-api/docs/models/gemini-3.1-pro-preview),
  [GPT-4o](https://platform.openai.com/docs/models/gpt-4o),
  [GPT-5.2](https://platform.openai.com/docs/models/gpt-5.2),
  [Grok 4.6](https://docs.x.ai/docs/models/grok-4.6.md), and
  [Gemini models.get](https://ai.google.dev/api/models).
- Azure [lists `gpt-5.2` at 400,000 total (272,000 input / 128,000 output)](https://learn.microsoft.com/en-us/azure/ai-foundry/openai/concepts/models),
  but **do not infer a deployment's model from its name**. After verifying the
  actual deployed model and version in Azure, configure that *exact* deployment
  as e.g. `{"azure:your-verified-deployment":{"contextTokens":400000,"outputTokens":128000}}`
  in `INSTANCE_CONTEXT_MODEL_LIMITS`. Until then, its percentage stays unknown.
- `INSTANCE_CONTEXT_MODEL_LIMITS`: JSON overrides keyed by the **actual**
  `provider:model` (for Azure, `provider:deployment`). Prefer explicit
  `{ "contextTokens": 128000, "outputTokens": 16384 }` for total-context
  models, or `{ "inputTokens": 1048576 }` if the provider publishes a separate
  input limit. Bare numeric values are supported for compatibility but reserve
  10% for output; they do **not** maximize the context. Never infer a custom
  Azure deployment's underlying model from the informational model name sent in
  the request body. xAI Vertex model IDs similarly need explicit overrides.
  Truly unknown models display "limit unknown" with a 6k-token history cap and
  no enforced input-window limit; the provider decides whether they fit.
- `INSTANCE_CONTEXT_SUMMARY_MODEL`: optional model ID available via the selected
  provider. If unset, the workflow's context-preparation step uses the effective
  model (the deployment ID for Azure) to summarize eligible older logs. This
  model may have a different capacity from the main model; its guard is checked
  independently before the summary call. For Azure, the configured deployment
  endpoint is always used; changing the model name in the request body does not
  change deployments, so the summary-model override is ignored there. For
  other providers, override only with an ID that the provider accepts.
- `PORTKEY_API_KEY` and `AZURE_OPENAI_API_KEY`: already used by
  `EmbeddingsService` to generate 1536-dimensional vectors via Portkey. Without
  them, the workflow skips the summarizer and does not move the cursor.

The workflow's context-preparation step checks eligible instance logs before
the model call and conditionally summarizes old contiguous logs when the
history budget is pressured. This is **not** a summary of the entire request:
instructions, tool definitions, attached resources and current messages can
dominate the estimate, and must not be silently replaced by a history summary.
After preparing a call, the executor also measures the complete request and
checks it against the verified window (if known). An unknown deployment has no
verified percentage or window guard, even when history summarization succeeds.

The composer button contains only a pie icon. Clicking it opens a dialog with
an estimated **prompt composition**: messages (including selected attachments),
tool calls/results, tool definitions, embedded required skills, and remaining
instructions/context. Tool-loaded skill content is counted under tool calls.
The category estimates sum to the estimated input, not to the provider's exact
aggregate token count. When that total differs, the difference is shown
separately rather than assigned to a made-up category. The outer ring displays
capacity utilization only for verified model limits; the composition pie works
even if the limit is unknown. Older measurements show no category pie until
a fresh model call saves a breakdown.

Keep these values out of `NEXT_PUBLIC_*`. The UI fetches only a scoped metrics
DTO via `market-fit/app/api/robots/instance/context/route.ts`.

## Behavior and limitations

- `instance_logs` is never deleted or rewritten by context management. Recent
  errors, tool calls, and infrastructure evidence remain available for audits.
- The cursor moves only when the database atomically persists a cumulative
  textual summary and vector and verifies the **exact ordered log IDs** of
  the segment. Queued user actions and unfinished streaming logs block
  compaction through their position.
- The most recent summary is always included. Semantic search can add one
  relevant older snapshot as supplementary, possibly superseded evidence.
- If the context migration is missing, the assistant cannot compact. When
  there are more un-compacted logs than the page can hold, it stops rather
  than silently skipping them; apply the migration before long-running use.
- If a cursor exists but its latest summary cannot be read, the assistant
  stops rather than proceed with silently lost context.
- The widget projects the next turn using the last measured/estimated input
  plus its output tokens. It is not a live counter for unsent characters.
  The reader refreshes every 15 seconds. Unknown output remains unknown, not
  zero, and the projection is a lower bound in that case. If the full prepared
  request exceeds the verified model window, the executor never drops
  un-compacted instance history. It may omit independently sourced advisory
  requirement/cron history; mandatory instructions, tactical evidence and tool
  schemas are never truncated. It raises `INSTANCE_CONTEXT_OVERFLOW` before
  contacting the model if the request still cannot fit.
  Hydrated `image_url` parts are estimated as image inputs (4096 tokens each),
  not as base64 text; this is a safety allowance, not a provider-accurate
  vision token count. Ordinary text and tool output still count by size.
- Requirement/cron calls use the shared full-request size guard, but retain
  their own requirement-scoped user history and independently bounded gate
  evidence. They do **not** advance this instance-wide compaction cursor:
  doing so would mix different requirements or omit actions from other runner
  instances. A separate requirement-scoped cursor is future work.

## If the usage chart stays empty after a message

- Confirm the composer has an existing `remote_instances.id` and that the
  authenticated `GET /api/robots/instance/context?instance_id=...&site_id=...`
  returns HTTP 200 with a non-null `context`. A `null` context means no model
  usage was saved for that instance; sending a message alone does not guarantee
  that the assistant reached a model call. An HTTP error means the read failed.
- Check `instance_context_state` for that instance in the **same** Supabase
  project used by both apps, and check the API server log for
  `[InstanceContext] Usage unavailable` if the model did run. The RPC must be
  executable by the API's service role. Do not insert placeholder usage or
  replay a customer turn to populate the chart.
- If PostgREST reports `42703: instance_context_state.output_tokens does not
  exist`, apply the forward-only output-tokens repair migration after checking
  the project's actual schema. A ten-argument RPC may exist but still fail to
  insert if the table is missing that column. Compatible readers and writers
  can fall back to the oldest schema temporarily, but cannot retroactively
  reconstruct output tokens from earlier turns.
  If the RPC remains HTTP 404 after the schema is repaired, check the actual
  PostgREST error code and its published signatures before considering a
  schema-cache refresh. Supabase's [schema refresh instructions](https://supabase.com/docs/guides/troubleshooting/refresh-postgrest-schema)
  document `NOTIFY pgrst, 'reload schema';` for an out-of-date cache; this is a
  separate manual operation on the intended project, not a replacement for
  the missing-column migration.
- A saved measurement with `available_tokens = NULL` means the effective model
  or Azure deployment has no verified capacity. Its input/output token counts
  are available, but no meaningful percentage exists until an explicit
  `INSTANCE_CONTEXT_MODEL_LIMITS` override is configured for the real
  `provider:model` and a new turn is measured.
- With a very large verified context window, a short turn can consume less
  than 1%. The UI labels it `<1%` and uses a minimum visible chart marker,
  which is intentionally not a precise visual proportion at that scale.

## Local verification

Run focused Jest suites in the API and `market-fit` repositories. The API suite
includes `src/lib/services/robot-instance/__tests__/instance-context-postgres.test.ts`,
which executes the migration's cursor and RLS SQL with PGlite. PGlite does not
ship pgvector: the runner substitutes the vector type/operator and HNSW index,
so verify those pieces on the target Supabase project before applying the SQL.

The PGlite regression suite runs the cursor SQL after substituting only
pgvector-specific syntax. Its competing calls share one embedded connection;
verify true multi-connection races and the HNSW index against a local PostgreSQL
with pgvector or a staging Supabase database before enabling production.

Before enabling on a production tenant: verify the real model limits, confirm
the `vector` extension and `hnsw` support, test cross-site RLS and manually
check a long instance with concurrent requests. The migration is intentionally
not applied by this change.