---
name: connector-crm-operations
description: Inspect external CRM contacts and sales records (for example HubSpot) using read-only, account-bound provider actions without starting outbound campaigns or changing native records.
types: ['task', 'integration', 'automation']
---

# External CRM Contact Inspection

## Objective

Inspect only the external CRM contacts or sales records requested by the member in a private interactive
turn. This is a read-only procedure, not authorization for sending or writing.

## Instructions

1. Use the selected account or ask which one the member intends. Multiple accounts
   of the same toolkit can offer the same action. Use `account_label` to distinguish
   them; if the suffix also matches, ask the user to select one in the account picker.
   Route by the full local `connector_id`, never a display name or provider account ID.
2. Search the provider catalog using `tools search` with `tool_origin: "provider"`, `connector_id` and a
   short public action term. The `crm` domain is an optional discovery
   hint, never permission. Follow the cursor even on an empty page. No private
   search terms or account credentials belong in a catalog query.
3. Describe the exact returned `connector:<id>:<SLUG>` reference. Check the
   operation and arguments; do not substitute a mutation, an unknown-effect
   action, another account or a native tool for the requested
   read. **All tools** permits compatible actions in Makinari; it does not expand the
   provider credential’s access. If the provider denies the read, stop on that account.
4. Use the described `version`, `schema_hash` and `arguments` envelope on the
   same account. Request the smallest useful page and projection. The host
   rechecks the member, pinned turn and current account policy before dispatch.
5. When a private record or link is useful, set `save_record: true` beside
   `arguments` in the original call. Otherwise omit it. Answer from the tool's
   result facts when available and give the private link only if returned.
   Do not claim to see private rows, treat a page as a total, or replay to save.

## Tools

`tools` search/list, describe and call; the same shared provider-direct route
serves all eligible connected accounts. Public channels, background jobs,
recovered turns and missing identities do not inherit a private user's grant.

## Artifacts

Return the requested facts, confirmed receipt or a clear blocker. Do not copy
private records into chat, shared files or logs, or auto-replay an uncertain outcome.
