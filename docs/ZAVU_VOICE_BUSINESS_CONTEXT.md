# Zavu Voice Business Context

Voice synchronization reuses AgentBase's stable background sources without needing
caller, lead, conversation, command, or other request-context factors.

## Sources and precedence

`src/lib/services/zavu/voice-background.ts` uses the existing `DataFetcher`,
`BackgroundBuilder`, `AgentService`, and `FileProcessingService` implementations:

- Site details and settings: company overview, business model, products/services,
  branding, locations, hours, public communication channels, strategy and goals.
- Team members, roles and organizational structure **configured in site settings**.
  This is not a new membership/profile-directory query.
- Approved copywriting and active campaigns.
- Linked agent files and deduplicated `configuration.contextFiles`.
- Agent identity, description, backstory, custom/system instructions and capabilities.

Nonempty configuration text takes precedence over the corresponding agent-row
field, matching AgentBase. Integration configuration, including webhook secrets,
is not serialized into the prompt. Existing authorized site/agent loaders remain
the data-access boundary; no new database access or migration is introduced.

## Provider budget

Zavu's system prompt remains limited to 10,000 characters. Previously, approximately
7,500 characters of runtime/tool instructions preceded the shared builder's date
snapshot and agent instructions. A prefix cut could omit **all** business context.

`voice-prompt-budget.ts` now:

1. Preserves the full voice runtime and final safety reminder.
2. Replaces the synchronization-time clock/filter bounds with the business timezone.
   Current dates must not be inferred from the last sync.
3. Omits AgentBase's generic workflow instructions, which are not live-call rules.
4. Retains complete background sections when they fit. On overflow, distributes
   space across sections, prioritizing company facts, agent instructions, services,
   team, hours, locations and channels over long biographies or reference text.
5. Marks excerpts and omitted context rather than silently cutting off the tail.
6. Rejects runtime growth that would leave less than 2,000 characters for context.

The standard runtime/tool summary uses under 5,600 characters. All enabled tool
names and required inputs remain listed; complete schemas and provider tool
descriptions are still registered separately. Voice consent, verified outcomes,
speech-only output, private metadata and final response checks remain enforced by
the prompt. Current/caller-specific facts still require relevant tools.

The limit means large sources cannot all be copied verbatim. Excerpts are not a
replacement for complete policies or live tool results; the agent must not invent
omitted facts. No call-specific or other customers' history is added to the shared
agent prompt.

## Rollout and verification

Both initial synchronization and the post-tool-registration prompt update use the
same composer. After deploying the API change, resynchronize existing Voice agents
to refresh the provider-stored prompt. A deployment alone does not rewrite it.

Offline regressions use the real `BackgroundBuilder` with synthetic sources and
mocked I/O. They cover company/team facts without contextual factors, long sources,
configuration precedence, prompt limits, full tool coverage and the final provider
update. Run `npm run test:voice`. Tests do not update Zavu or place calls.