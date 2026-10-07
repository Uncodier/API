# WhatsApp and node entity-context diagnosis (2026-10-06 UTC)

## Read-only database evidence

The requested fixtures exist in site `dea92504-319d-4950-943f-503280f1727c`:

| Entity | ID | State |
| --- | --- | --- |
| content | `06780803-b7d5-588e-a5b1-21b77da49e5d` | draft |
| lead | `a158458f-2734-565b-a561-2d7afda67193` | new |
| catalog_item | `46186d7e-0729-5a3e-a2f0-cc27b8e4ce2d` | active |

All were created at `2026-10-06 00:11:57.75149+00`, with metadata
`qa_fixture=shiplight-production-smoke-v1`. Content/lead command IDs are null.
None of these IDs appears in the scoped messages, tool arguments/results,
details, node prompts/results, or command targets/results/context inspected.
The site has 7,468 instance logs (last September 26), ten nodes (last September
21, pending), 5,833 commands (last September 22), and no workflow runs.
These fixtures are not evidence of a recent assistant execution.

## Actual WhatsApp incident

The failing conversation belongs to a different site,
`fadd3df5-97a5-4c25-a7af-bdc26570bcd8`, and instance
`b5e382bc-4933-4622-a9a9-01706313866c`.

Two inspected user-action logs:

- `19e73f0d-2bee-4e6a-b6de-3a18ff0362c3`, October 5 at 20:42:14 UTC.
- `978405d3-b5bd-410e-979b-84e022994bf6`, October 6 at 00:43:39 UTC.

Both ask what is visible in an attached image. The assistant repeats the same
CarneMart ticket description. Their checkpoints have no node ID/context string,
no respawns, and three messages: system/user/assistant. The multimodal user
message contains the current asset twice, followed by older assets in reverse
upload order. It uses the old flat uploaded-URL list without adjacent image
identity labels. Current source does not build this shape.

This establishes an old runtime/checkpoint shape, not a node-mode takeover.
It does not identify the exact deployed build or prove what pixels the model saw.

## Local fixes and validation

- Preserve chronological tool/user/assistant interleaving, log IDs, timestamps
  and selected identity/provenance fields in history and compaction input.
- Use a tactical index instead of moving old tool payloads after new selections.
- Protect recent completed assistant selections in bounded history previews.
- Preserve linked-node structured result data alongside prose. Prompt references
  use prompt images; result references use result images, without mixing them.
- Collect typed content/lead/catalog output identities in node results. Persist
  only reference fields, not entire CRM/customer payloads. Lists remain candidates;
  no implicit first/newest mutation target is introduced.
- Mark node assistant/tool logs with execution mode and prompt-node ID.
- Keep structured selection identity in partial-history headers even if the
  assistant's explanation is too long and must be excerpted.
- Protect explicit current/reply/linked image sources from later screenshots and
  report every budget omission. Inventory text does not assert visibility.
- Reject confirmed canvas/node-shaped context without an explicit node ID at
  both HTTP admission and durable preparation (`NODE_CONTEXT_REQUIRES_NODE`).
  Ordinary prose/JSON context is preserved; embedded IDs are not execution scope.
- Mark image context and assistant/tool logs with `image-entity-v2`; record
  validated `VERCEL_GIT_COMMIT_SHA` and `VERCEL_DEPLOYMENT_ID` when available.
  This does not invent the unknown deployment identity of historical incidents.
- Admit registered WhatsApp messages before slow media processing. Enrich only
  that scoped action via details CAS; preserve its timestamp and newer ownership.
  Superseded attachments may finish for history but do not restart their turn.
  Pending/partial/failed media and transcriptions have explicit unavailable notices.
- Separate the publish binder's 20-media limit from its bounded allowance for
  structured data outputs. A normal 50-entity lookup no longer invalidates a text
  or video result, and entity-reference URLs never become publication attachments.

Offline tests reproduce the losses before the patch and exercise a routed tool
result -> serialized node storage -> linked context round trip after it. Existing
billing worktree changes were preserved. No production data was changed and no
sends, publications, purchases or provider model calls were triggered.

Final local validation (suite groups overlap; counts are not additive):

- `npm run test:ai -- --silent`: 56 suites, 788 tests passed.
- `npm run test:harness -- --silent`: 194 suites, 3,071 tests passed.
- Eight ESM integration/recovery/compiler/credit-precision suites: 164 tests passed.
- `tsc --noEmit --incremental false`: exit 0; `git diff --check`: clean.

The migration CLI table test now receives each full argument array instead of
Jest spreading it into individual callback arguments; the offline credit runner
sets `NODE_ENV=test`. Two recovery integration mocks include the existing billing
pause export. These fix validation setup without changing billing behavior.
No full Next production build or deployment was performed in this repair.

## Operational next steps and limitations

After an authorized deployment, verify that a new inbound action has the
`image-entity-v2` marker, image identity labels, current-attachment markers,
chronological history and the expected node/conversation provenance. Check
`details.runtime_commit_sha` / `details.runtime_deployment_id` against that build
when available. The real Workflow compiler test validates local bundling, not
deployment. Do not blindly replay old checkpoints: they may contain old context and external-effect
receipts. Do not connect the fixture site to the WhatsApp tenant or treat the
supplied IDs as authorization.

Admission is not a distributed FIFO: scope resolution precedes insertion, and
the latest-owner check and requirement reset remain separate database operations.
Pending-media warnings are conservative snapshots, not tool-level dependency
locks or an automatic replay mechanism; interrupted preparation may need retry.
Requests exceeding the five-image vision budget and ambiguous lead qualification
still require clarification. Explicit visual-node context without a node ID
fails closed rather than silently becoming conversation. Shared `mediaType`,
`media_type` and `output_type` preferences alone are not node context: normal
instance conversations and queued work also use these fields. The API accepts
them without `instance_node_id`, while a supplied node ID remains scoped to its
instance and site and is preserved across continuations.
The patch improves deterministic context preservation; offline tests do not
guarantee the natural-language interpretation of a live model.
