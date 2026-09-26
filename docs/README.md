# Internal Engineering Documentation

This directory contains internal engineering documentation. Customer-facing documentation belongs in `/src/content`.

Documents are ordered below by relevance and freshness. A dated checkpoint records the implementation at that date; current code and migrations remain authoritative.

## Current architecture

Read these first when changing the code-agent harness:

1. [Code-agent harness checkpoint — 2026-09-17](./CODE_AGENT_HARNESS_CHECKPOINT_2026-09-17.md)
2. [Harness reliability appendix — 2026-09-17](./CODE_AGENT_HARNESS_RELIABILITY_CHECKPOINT_2026-09-17.md)

## Availability audits

- [Redis/Upstash availability and consistency audit — 2026-09-20](./REDIS_UPSTASH_AVAILABILITY_AUDIT_2026-09-20.md)

## Active integration guides

- [Instance context manual setup](./INSTANCE_CONTEXT_MANUAL_SETUP.md) — migration and model-limit configuration for robot context compaction.

These integrations still exist, but verify configuration details against the referenced implementation before operational changes:

- [API-key authentication](./README-ApiKeyAuth.md) — active; middleware exceptions and environment behavior have evolved.
- [SendGrid](./README-SendGrid.md) — active; branding, membership, and sandbox behavior have evolved.
- [ScreenshotMachine](./README-ScreenshotMachine.md) — active; vendor pricing and credentials are time-sensitive.
- [Team invitations](./README-TeamInvite.md) — active; historical test and limit claims may no longer apply.
- [WhatsApp template approval](./WHATSAPP_TEMPLATE_APPROVAL.md) — active; Twilio approval category and retry behavior have evolved.

## Implementation history

These files explain previous fixes or migrations. They are useful for context, not as current architecture specifications:

- [Plan lifecycle fix](./PLAN_LIFECYCLE_FIX_SUMMARY.md) — partially superseded by atomic plan state and the single-active-plan invariant.
- [AgentMail timestamp validation](./AGENTMAIL_TIMESTAMP_VALIDATION_FIX.md)
- [AgentMail fallback search](./AGENTMAIL_FALLBACK_SEARCH_FIX.md)
- [Generate-image tool formats](./GENERATEIMAGE_TOOL_FIX_SUMMARY.md)
- [IMAPFlow migration](./MIGRATION-IMAPFLOW.md)
- [Rate-limit handling](./RATE_LIMIT_ERROR_HANDLING.md) — current fallback behavior is broader than this record.
- [Streaming timeout fixes](./STREAMING_TIMEOUT_FIXES.md)

## Maintenance policy

- Prefer architecture checkpoints and active integration guides over fix summaries.
- Add a capture date to architecture snapshots and point-in-time audits.
- Delete proposals that were never implemented and summaries superseded by canonical documentation.
- Do not publish API keys, shared demo credentials, tokens, or environment values.
- Keep documents below 500 lines; split appendices when necessary.
- Centralize shared infrastructure knowledge here instead of duplicating it across frontend repositories.
