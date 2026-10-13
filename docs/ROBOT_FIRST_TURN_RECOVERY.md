# Robot first-turn ownership and research recovery

## Failure addressed

A new assistant conversation can create a requirement after its initial context
was serialized. Previously, `hasLinkedRequirement` remained false; the workflow
then sent the newly requirement-owned plan to the interactive executor. That
executor rejected its still-pending backlog and cancelled the plan.

The workflow now resolves persisted ownership after the conversation, scoped by
site and instance. Explicit plan linkage, the requirement's original runner
assignment, and legacy status linkage are checked without rebuilding the model
context. Managed work stays with the requirement runner on the same instance.
The completed user action enables the existing database handoff checks; this is
not an immediate execution receipt or a claim that the report is complete.

The interactive executor repeats admission using the current plan. Unknown,
conflicting or inactive ownership pauses without cancelling pending work.
Interrupted interactive checkpoints anywhere in the plan prevent handoff, so
previous effects cannot silently be replayed by a different executor. Existing
cron ownership checks, cancellation rules and retry budgets remain in force.
These reads are not a new atomic cross-service ownership protocol.

## History tool

The model-facing `instance_history` contract uses a nested `request` with mutually
exclusive list/read shapes, generated from the reader's validators. Optional
model fields use explicit null defaults within the selected action. Valid legacy
flat calls remain supported. Wrong-action fields get actionable, bounded errors;
arbitrary property names/values are not echoed. Scope overrides remain forbidden.

## Research: implemented boundaries and remaining limitations

An explicit report-only task contract (`step_output`, report/informe and no
files/repository, with no code touches or executable application claims) must not
be judged as application code merely because its backlog kind is `doc`.

The runner captures bounded, redacted reports and correlated successful
`webSearch` source receipts in canonical evidence. These are material for review,
not proof that the report's conclusions are correct. Missing or fabricated source
receipts do not pass structural validation. Repeated old receipts are not counted
as new progress. Research material is checked against its requirement, item, plan
and execution generation before use.

**There is not yet a source-grounded semantic research reviewer.** Structurally
present report/source evidence therefore requires platform review rather than
automatic approval or a request to create code/lint artifacts. This change does
not make every research request autonomously completable. It also does not remove
the cron runner's internal sandbox/bootstrap lifecycle.

For a wholly report-only requirement, repository push, source archive and
repository/deployment delivery finalization are skipped. Mixed requirements and
application/code obligations retain their existing delivery gates. Suppression
does not count as a successful push or a completed report.

## Validation and rollout

- First-turn regression: create requirement during a generic conversation, keep
  its plan/backlog pending, complete only the user action, preserve the instance.
- Test standalone plans, unavailable/ambiguous/cross-site ownership, inactive
  instances, changed ownership and interrupted sibling checkpoints.
- Exercise existing PostgreSQL handoff tests to ensure cron cannot run while the
  original assistant action is active and may claim after completion.
- Test generated history schemas, installed provider conversion, routing, strict
  reader validation, query scoping and paging without live credentials.
- Compile the workflow using the real Workflow SDK plugins, without importing
  server/database code into the workflow VM.
- Test report evidence, fail-closed research adjudication and unchanged app gates.

Deployment and recovery of existing sessions are separate from local code edits.
Do not reset all attempts, remove holds, duplicate instances, or mark cancelled
work complete. Inspect current ownership and checkpoints before using the
authorized recovery path. Old queued workflows may still use their original
deployment; a new deployment does not prove an old session was recovered.