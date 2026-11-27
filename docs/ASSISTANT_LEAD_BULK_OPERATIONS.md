# Bulk lead operations in the assistant

In an interactive assistant conversation authenticated with a verified user session, discover `leads_bulk_operations` in the `crm` category of `tools`. The tool uses the site's Leads permissions and the current conversation's user. It is not a public REST endpoint and isn't exposed to API-key callers, background jobs, or node executions.

| `action` | Input |
| --- | --- |
| `create` | `leads`: records with `name` and an `email` or `phone`; optional `company`, `position`, `notes`, `origin` and `status`. This is insert-only, not an upsert or deduplicating import. |
| `assign_to_me` | `lead_ids`: select exact lead UUIDs and assign them to the current user. |
| `assign_to_member` | `lead_ids` and `assignee_id`: assign all selected leads to one teammate with active access to the site. Find their user UUID in `team_members` using `calendars` with `action: "list"` and their name or email as `query`. Use `user_id`, not the membership record ID. |
| `change_status` | `lead_ids` and `status`: `new`, `contacted`, `qualified`, `converted`, `lost`, `cold`, or `not_qualified`. |
| `delete` | `lead_ids`. Owners/admins only; the user must confirm the exact preview in chat. Deletion is permanent and can also remove linked records. |

For 1–50 records, use the interactive path below. For larger selections, use a durable job. Use `leads` with `action: "list"` to find the right IDs; do not treat a partial page as the full selection. The default `dry_run: true` returns `matched_count`, `missing_lead_ids`, and a summary without mutating leads. A complete preview returns a `preview_id` valid for 30 minutes. To apply, pass the same batch with `dry_run: false`, that `preview_id`, and `expected_count` equal to `matched_count`. The database checks the live permissions and, for existing leads, the full reviewed row state under locks. If any selected row is gone, inaccessible, or changed, none of the leads are modified.

For deletion, show the preview and ask the user to send the returned `confirmation_message` exactly as a new message in the same conversation. The assistant cannot supply the confirmation as a tool argument. If the selection or a lead's revision changes, preview and confirm again.

For `assign_to_member`, keep the same `assignee_id` when applying. The database rechecks that the assignee still has access to the site. If they no longer qualify, the entire batch is rejected and no lead is reassigned.

Use `affected_count` and `affected_lead_ids` to report what happened. If the result is `LEAD_BULK_OUTCOME_UNKNOWN`, reuse the same preview ID and batch, not a new preview. The database commits the write and its receipt together and returns the same receipt on replay, even after the original preview expires. A new create preview in the same turn for the exact same input returns the original preview ID.

## Durable jobs for larger selections

The job total is not limited to 50. For existing leads, `job_select` accepts an explicit `selection_filter: { "all": true }` or `{ "status": "contacted" }` (an exact current status), plus the same execution settings as `job_open`. The cron scans bounded pages in site/ID order and stages matching accessible leads, without lead writes. Poll `job_status` until `selecting` becomes `draft` before sealing. This is a paged scan of live data, not a point-in-time query snapshot: membership is frozen once staged, and the worker checks each lead's staged revision before mutating it. An empty selection cannot be submitted.

Use the manual path for specific IDs or create drafts. Stage at most 50 items per call; staging can span multiple chat turns. File imports are not supported.

1. `job_open` with `operation` from the table above and any required `status` or `assignee_id`. Keep its `job_id`. Opening the same operation and settings again in the same turn returns the original job.
2. `job_add` with `job_id`, sequential `batch_number` starting at 1, and `leads` or `lead_ids`. A missing or inaccessible ID or a duplicate across batches rejects the entire append. If the result is uncertain, resend the exact same batch number and input. A draft expires after 24 hours without a new batch.
3. `job_seal` with `job_id` and `expected_count` equal to the intended total. This freezes the manifest and returns a preview valid for 30 minutes. Read the exact selection with `job_preview`, passing `job_id` and `batch_number: 1`, then use `next_batch_number` until it is `null`. The response includes names and statuses for unchanged rows and flags changed or unavailable rows. Review the relevant pages before requesting confirmation. For `delete`, the user must send the exact `confirmation_message` from the sealed receipt in a new message in the same chat. Do not use individual batch confirmations.
4. `job_submit` with the same `job_id` and `expected_count`. `queued` means accepted for background processing, not applied. If the response is uncertain, check `job_status` or retry the same submit. Never start a replacement job to retry an uncertain mutation.
5. `job_status` with `job_id` reports the applied and remaining counts, completed batch count, and first terminal failure if any. `job_cancel` stops pending batches, not those already committed.

Batches commit in order, independently. Each worker transaction rechecks live permissions, assignee access and existing lead revisions, and records its progress atomically with the mutation. Transient database failures back off and retry; a permanent failure stops the job at that batch without rolling back earlier batches. Completed items are removed as they commit; terminal receipts and any unprocessed drafts are pruned after seven days. Drafts can contain contact data and are accessible only to the service RPCs.

Deploy the bulk operations (`20261120233000`), team assignment (`20261123120000`), jobs (`20261123180000`), cursor index (`20261123181000`, run outside a transaction), and selection/review (`20261123181100`) migrations before publishing the assistant change. The job worker runs every minute at `/api/cron/lead-bulk` using the existing `CRON_SECRET`. Each invocation handles at most 20 processing batches and selection pages combined, within a wall-clock budget. On non-Vercel deployments, configure the same authenticated cron route.

### Worker recovery after an incomplete rollout

If production has the base jobs migration but the worker reports `PGRST202` for
`assistant_lead_job_select_tick`, read the migration ledger and check the SQL
function with `to_regprocedure('public.assistant_lead_job_select_tick()')`.
When absent, apply the pending cursor-index migration outside a transaction,
verify `public.assistant_lead_bulk_leads_site_cursor` is valid, then apply the
selection/review migration, which also requests a PostgREST schema reload.
Do not reapply the base migrations or skip the selection RPC to make status green.
If the function already exists, check its service-role grant and PostgREST schema
cache before considering any migration. Use the next scheduled execution and its
receipt to verify recovery; do not invoke the mutating worker as a probe.

The worker logs the failed RPC and a bounded error code without database messages
or job payloads. A failed RPC still returns `503` and records a failed check.