---
name: connector-crm-operations
description: Inspect external CRM contacts and sales records (for example HubSpot) using read-only, account-bound provider actions. Discover live schemas and deliver a private receipt without starting outbound campaigns or changing native records.
types: ['task', 'integration', 'automation']
---

# External CRM Contact Inspection

## Objective

Inspect only the external CRM contacts or sales records requested by the member in a private interactive
turn. This is a read-only procedure, not authorization for sending or writing.

## Instructions

1. Resolve the user's intended connected account. If the account is ambiguous,
   ask; do not select the first connection or try a second credential on denial.
2. Search the provider catalog using `tools search` with `connector_id` and a
   short public action term. The `crm` domain is an optional discovery
   hint, never permission. Follow the cursor even on an empty page. No private
   search terms or account credentials belong in a catalog query.
3. Describe the exact returned `connector:<id>:<action>` reference. Check the
   operation and arguments; do not substitute a mutation, an unknown-effect
   action or a native report for the requested read. The version and schema
   are evidence about the contract, not a grant. Do not invent action slugs.
4. Use the described `version`, `schema_hash` and `arguments` envelope on the
   same account. Request the smallest useful page and projection. The host
   validates the member, agent and current account policy before dispatch.
5. Give the user the private result link. Never claim to have read or summarized
   rows that were only delivered to the private viewer. A page is not a total.

## Tools

`tools` search/list, describe and call; the same shared provider-direct route
serves all eligible connected accounts. Public channels, background jobs,
recovered turns and missing identities do not inherit a private user's grant.

## Artifacts

Return the confirmed receipt or a clear blocker. Do not write private data to
chat, shared files or logs, or auto-replay an uncertain external outcome.
