# Notification CTA and details compatibility

## Findings and corrections

- Audited all 16 `/api/notifications` routes; the detailed inventory is in
  `src/app/api/notifications/AUDIT.md`.
- All nine existing in-app route emitters now retain available full plaintext
  details, including inbound messages previously truncated to 100 characters.
- Task creation (team and assignee), `TaskNotifier`, and human intervention now
  retain description/summary, contact, priority, schedule, and other available facts.
- The frontend in the sibling `market-fit` repository now supports CTA targets
  for conversations, tasks, instances, leads, sites, campaigns, content,
  requirements, and segments, plus safe existing `action_url` destinations.
- Aggregate alerts use `action_url` for their actual section: `/leads`,
  `/campaigns`, `/content`, or `/dashboard`. Existing billing notifications
  already store `/billing`; the frontend now honors it.
- System notifications link to `/robots?instance=ID`, or `/projects` without an
  instance. Chat links use `conversationId`; settings links use
  `/settings?tab=channels`. No `/sites/:id` page exists in the frontend.
- Platform API notifications previously used nonexistent `body`, `level`, and
  `metadata` columns and omitted required `user_id`. They now use `message` and
  `type`, resolve the site owner, and link to a verified requirement or site.
  SDK legacy `body`/`level` aliases remain supported; nonempty details are required.
  Recipient/tenant/entity/URL overrides are rejected rather than trusting callers.

## Existing contract, no migration

`message` is the full plain-text details source. The frontend keeps a 240-character
preview and accessible expansion; short messages do not need artificial padding.
`related_entity_type`/`related_entity_id` identify the actual entity. Optional
`action_url` already exists in the table and supplies list or billing CTAs.
Unknown entities without a safe action URL do not receive invented destinations.

No new recipients or in-app delivery flows were added to email-only routes.
The direct task/reservation/subscription email wrappers accept caller-provided
markdown actions but lack entity identifiers. Those actions are validated and
escaped; when no valid action is supplied, no entity-specific CTA can be inferred.
Existing stored messages are not rewritten or backfilled: new events carry richer
details, while existing supported entity/action links become visible with the UI update.
Workspace selection remains explicit; list CTAs operate in the selected site.

## Validation

```sh
npm run test:notifications
npm run test:tasks
```

Frontend (from the sibling `market-fit` repository):

```sh
npm test -- --runInBand __tests__/app/notifications __tests__/lib/notifications
```

Tests are offline: persistence/provider boundaries are mocked, route payload
arguments and email renderers are evaluated using synthetic facts, and frontend
CTA destinations are checked against existing page files. They do not prove
live email delivery or deployed browser navigation. API and frontend must both
be deployed for the full behavior.