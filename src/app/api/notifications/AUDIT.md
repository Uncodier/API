# Notification route CTA/details audit

Scope: all 16 `*/route.ts` files in this directory. Read workspace AGENTS,
secret-scanning policy, and installed Next 16.4 route-handler/convention guides
before editing. POST signatures, recipient selection, categories, email locale
builders and database flows are unchanged. No migration or new notification
contract fields: richer plaintext uses `message`; CTA association uses existing
`relatedEntityType`/`relatedEntityId` (persisted as snake_case by the service).

## Complete coverage

| Route | In-app audit / useful available facts | Email CTA audit |
| --- | --- | --- |
| dailyStandUp | Full summary plus computed business assessment, preserving report-section eligibility | Existing dashboard button retained |
| leadAssignment | Brief, next steps, due date, priority, contact, company, position, status, origin, assignee and context | Existing lead detail buttons retained; direct assignee email unchanged |
| newInboundMessage | Removed 100-character truncation; complete message, contact, priority, site; conversation entity | Fixed chat query to `conversationId`, matching frontend |
| newCampaigns | Every fetched campaign's full description, type, status, priority, due date, budget, revenue, creation, assignees and issues | Review/list CTAs retained |
| newContent | Every fetched item's full description, type, status, creation, word count and reading time | Review/list CTAs retained |
| newLeadsAlert | Every fetched lead's contact, company, status, origin, creation and segment facts | Assign/list CTAs retained |
| projectAnalysis | Actual analysis summary/type/impact and complete insight descriptions/affected areas rather than fixed generic summary | Existing dashboard CTA retained |
| taskStatus | Full message, task description, status, priority, lead email, additional data and action; **lead type when no task ID** | Both team and lead primary CTAs fall back to task/lead detail for missing/unsafe URLs; valid actions retained |
| taskCommentReminder | Full message, description, status, priority, lead email, context, additional data and action | Existing comment-CTA requirement retained; malformed URLs fall back to task detail |
| leadAttention | Intentionally existing assignee-only email; no new in-app flow | Existing lead detail/chat/reply buttons retained |
| channelsSetupRequired | Intentionally email-only selected team recipients | Settings button now targets existing `/settings?tab=channels` |
| agentmailQuotaError | Intentionally owner email only | Invalid `/settings/channels` corrected to `/settings?tab=channels`; nonexistent `/support` replaced by configured `UNCODIE_SUPPORT_EMAIL` mailto (existing platform fallback) |
| emailSyncFailure | Intentionally owner email only | Same settings/support corrections |
| taskReminder | Intentionally direct email to caller recipient | Caller markdown CTA retained, escaped attributes; malformed/unsafe links render label without broken button |
| reservationReminder | Intentionally direct email to caller recipient | Same markdown CTA handling; no entity facts in request to invent a reservation button |
| subscriptionRenewal | Intentionally direct email to caller recipient | Same markdown CTA handling; no subscription entity facts in request |

## CTA entity types communicated to frontend

Only `lead`, `task`, `conversation`, and `site` are needed by these existing
emitters. Frontend confirmed lead/task detail routes and chat `conversationId`.
Batch campaign/content/lead alerts keep the actual **site ID with site type**,
not fake campaign/content/lead IDs. Their in-app CTA uses the existing
`action_url` column to open `/campaigns`, `/content`, or `/leads`; daily summaries
and project analysis open `/dashboard`. The frontend prioritizes these safe
internal destinations. No new database column was added.

## Offline verification and limitations

Run from the repository:

```sh
node --test src/app/api/notifications/__tests__/emitters.test.mjs
```

The suite discovers every route, extracts **actual** `notifyTeam` argument ASTs,
transpiles/evaluates them offline with synthetic available facts, and checks full
message tails, structured data, correct entity pairs, optional batch-detail flags,
and route-specific existing action URLs. It executes the three direct-email renderers,
tests CTA validation/fallback and checks corrected frontend destinations.
No database, environment credentials, Next server, provider, or network required.

Limits: these are emitter-contract tests, not full POST/recipient/database
integration tests. Shared service storage limits, frontend rendering/truncation,
authorization and delivery are outside ownership. Batch details cover fetched
rows only (existing query limits), not all database records; existing
`include_*_details=false` intentionally suppresses row details. Project analysis
keeps existing default insights when caller supplies none. Existing rich email
templates and markdown wrappers are not a general HTML sanitizer; this change
hardens markdown link destinations/attributes, not all caller HTML. Valid
external CTA destinations are syntax-checked, not contacted or guaranteed live.
No live email, end-to-end navigation, or whole-repository build was required.