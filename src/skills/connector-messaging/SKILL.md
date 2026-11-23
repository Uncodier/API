---
name: connector-messaging
description: Inspect external Gmail or other inbox email and messages through read-only, account-bound provider actions. Discover the actual mailbox contract and deliver a private receipt without sending messages or bypassing native channel controls.
types: ['task', 'integration', 'automation']
---

# Connector Inbox Inspection

## Objective

Inspect only the external inbox messages requested by the member in a private interactive
turn. This is a read-only procedure, not authorization for sending or writing.

## Instructions

1. Use the selected account or ask which one the member intends. Multiple accounts
   of the same toolkit can offer the same action. Use `account_label` to distinguish
   them; if the suffix also matches, ask the user to select one in the account picker.
   Route by the full local `connector_id`, never a display name or provider account ID.
2. Search the provider catalog using `tools search` with `tool_origin: "provider"`, `connector_id` and a
   short public action term. The `communication` domain is an optional discovery
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
5. Give the user the private result link. Never claim to have read or summarized
   rows that were only delivered to the private viewer. A page is not a total.

## Tools

`tools` search/list, describe and call; the same shared provider-direct route
serves all eligible connected accounts. Public channels, background jobs,
recovered turns and missing identities do not inherit a private user's grant.

## Artifacts

Return the confirmed receipt or a clear blocker. Do not write private data to
chat, shared files or logs, or auto-replay an uncertain external outcome.
