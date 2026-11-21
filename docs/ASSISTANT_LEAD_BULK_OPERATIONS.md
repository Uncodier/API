# Bulk lead operations in the assistant

In an interactive assistant conversation authenticated with a verified user session, discover `leads_bulk_operations` in the `crm` category of `tools`. The tool uses the site's Leads permissions and the current conversation's user. It is not a public REST endpoint and isn't exposed to API-key callers, background jobs, or node executions.

| `action` | Input |
| --- | --- |
| `create` | `leads`: records with `name` and an `email` or `phone`; optional `company`, `position`, `notes`, `origin` and `status`. This is insert-only, not an upsert or deduplicating import. |
| `assign_to_me` | `lead_ids`: select exact lead UUIDs and assign them to the current user. |
| `change_status` | `lead_ids` and `status`: `new`, `contacted`, `qualified`, `converted`, `lost`, `cold`, or `not_qualified`. |
| `delete` | `lead_ids`. Owners/admins only; the user must confirm the exact preview in chat. Deletion is permanent and can also remove linked records. |

Each call accepts 1–50 records. Use `leads` with `action: "list"` to find the right IDs. The default `dry_run: true` returns `matched_count`, `missing_lead_ids`, and a summary without mutating leads. A complete preview returns a `preview_id` valid for 30 minutes. To apply, pass the same batch with `dry_run: false`, that `preview_id`, and `expected_count` equal to `matched_count`. The database checks the live permissions and, for existing leads, the full reviewed row state under locks. If any selected row is gone, inaccessible, or changed, none of the leads are modified.

For deletion, show the preview and ask the user to send the returned `confirmation_message` exactly as a new message in the same conversation. The assistant cannot supply the confirmation as a tool argument. If the selection or a lead's revision changes, preview and confirm again.

Use `affected_count` and `affected_lead_ids` to report what happened. If the result is `LEAD_BULK_OUTCOME_UNKNOWN`, reuse the same preview ID and batch, not a new preview. The database commits the write and its receipt together and returns the same receipt on replay, even after the original preview expires. A new create preview in the same turn for the exact same input returns the original preview ID.

Deploy `supabase/migrations/20261120233000_assistant_lead_bulk_operations.sql` before publishing the assistant change. The RPC is service-only; receipts keep hashes and IDs, not contact data.