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

The composer additionally reserves an uncut business brief (at most 1,600
characters) immediately after the runtime. It names the represented business,
gives a short overview, and lists complete service/product names before optional
background sections share the remaining space. Long descriptions, internal costs
and offering metadata are not copied into this brief. Very large lists explicitly
mark omitted names; this overview never substitutes for live availability/prices.
It tells the agent to clarify speech-recognition ambiguity instead of adopting
a different business suggested by the transcript. For an unverified appointment
offering, it names the represented business and asks whether the caller means
that business before asking for a subtype or booking date.

The standard runtime/tool summary uses under 5,600 characters. All enabled tool
names and required inputs remain listed. Zavu preserves only type/description
inside tool properties, so the voice adapter also puts allowed values and nested
field requirements in those descriptions. The authoritative source schemas stay
local and are validated after trusted site/caller scoping, before execution.
Invalid arguments return `VOICE_TOOL_INVALID_ARGUMENTS` and `invalid_fields`;
unknown resources are never silently coerced to a write-capable operation.
Voice consent, verified outcomes, speech-only output, private metadata and final
response checks remain enforced by
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

## Tool error visibility

The transcript projector supports both `{http_status, http_body}` and the
provider envelope `{ok:false, error:"Webhook returned 422: ..."}`. Only validated
HTTP status and UUID request IDs cross into chat; arbitrary tool bodies, headers
and caller data remain excluded. Parsing is bounded and never evaluates text.
Existing messages are not rewritten automatically: replay only an explicitly
identified call through `persistVoiceTranscript` to insert missing diagnostics
with the same deterministic IDs and `ignoreDuplicates` behavior.

### Targeted repair on 2026-10-01

- Updated Krystal Payne's existing provider agent with the new business brief
  and all 16 projected tool contracts. Verified the stored prompt and parameters by
  reading them back. Model, voice settings, sender assignment, enabled state,
  webhook URLs and secrets were not changed.
- Replayed only conversation `ac6facea-c63a-5f95-aa68-d1275afa15cd` with the fixed
  projector. Added the missing HTTP 422 diagnostics at sequences 4 and 15;
  the 16 existing messages were preserved.
- A tool-disabled agent rehearsal identifies Makinari and chooses
  `catalog_commerce` with `action=list`, `kind=service` and either `resource=item`
  or the equivalent omitted resource (the executor defaults to `item`).
  After the final prompt refinement at 22:39 UTC, the ambiguous phrase
  "cita de maquinaria" prompted clarification naming Makinari rather than
  an assumption that the business rents machinery.
  This rehearsal is not a real voice-call acceptance test.
- An explicit read-only catalog tool test completed with `run.success=true`
  and HTTP 200. It did not book, create or update any customer record.
- All 595 offline tests in 31 Voice suites passed. The global TypeScript check
  still reports errors outside the changed Voice files, so a clean full-project
  typecheck/build is not claimed.
- Backend source deployment is still required for automatic projection and
  argument validation on future calls. Do not resynchronize with an older
  backend before deploying this patch: it would overwrite the provider repair.