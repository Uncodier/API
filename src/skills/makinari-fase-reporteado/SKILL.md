---
name: makinari-fase-reporteado
description: Reporting phase. Close the cycle by creating `requirement_status`, marking steps complete, and writing a client-facing message that explains the deliverable.
types: ['develop', 'automation', 'content', 'design', 'task', 'integration']
---

# SKILL: makinari-fase-reporteado

## Objective

"Close the cycle and deliver." Register progress, publish the final URLs, and write a message the client can actually read. This is the only step that speaks to the client directly — quality of the message is as important as the deliverable itself.

## Execution Rules

### 1. Git is handled by the system
The system auto-commits and pushes after the prior steps. Do NOT run `git commit` or `git push`. The permanent preview URL comes from the GitHub Deployments API after push.

### 2. Report step progress
Use `instance_plan action="execute_step"` to mark your step completed:
- `step_id`: exact id from the plan (e.g. `step_6`).
- `step_status`: `"completed"`.
- `step_output`: short internal summary (one sentence).

### 3. Create the client-facing status
Use `requirement_status action="create"` with:

| Field | Rule |
| --- | --- |
| `status` | `"done"` if the requirement is fully delivered; `"in-progress"` if more cycles are queued. |
| `preview_url` | The permanent Vercel deployment URL (from the system). Never guess. |
| `endpoint_url` | Only for automations — the deployed API endpoint. |
| `message` | Client-facing summary. Follow the template below. |

### 4. Writing a good `message`
The client will read this directly. Follow this template:

```
<ONE LINE — what was delivered, in the client's language>

Cómo probarlo:
- <one step to open / test the deliverable>
- <second step if applicable>

Qué incluye:
- <bullet 1>
- <bullet 2>
- <bullet 3>

Pendiente (si aplica):
- <what the client should know is NOT in this cycle>
```

**Rules**
- Write in the client's language (default Spanish for Uncodie clients, unless the site settings say otherwise).
- Keep it under ~10 lines. The platform UI truncates long messages.
- No internal jargon: avoid "sandbox", "checkpoint", "gate". Translate to client-facing verbs.
- If the deliverable has a known gap (from `qa_results.json` or a Non-Goal), state it plainly.

### 5. Archive
The workspace archive is uploaded automatically on each `sandbox_push_checkpoint` (and after `sandbox_restore_checkpoint`). You do NOT need to call these manually.

### 6. Update the requirement
- If fully complete: `requirements action="update" status="done"`.
- If more cycles are needed: keep as `"in-progress"` and leave the message flagged with pending work.

## Tools

| Tool | When to use |
| --- | --- |
| `instance_plan` | `action="execute_step"` to mark the reporting step complete. |
| `requirement_status` | `action="create"` with final URLs and client message. |
| `requirements` | `action="update"` to flip the requirement `status` when fully delivered. |
| `sandbox_read_file` | Read `test_results.json` and `qa_results.json` to ground the message in real outcomes. |

## Artifacts

- **Produces**: a `requirement_status` DB record; optional `requirements status="done"` flip.
- **Consumes**: `test_results.json` (validation / devops), `qa_results.json` (QA), preview URL from the gate, requirement section 3 (Goals) and 4 (Non-Goals) for the message framing.

## Anti-patterns

- Long, technical messages that confuse the client. The message is a handover, not a changelog.
- Reporting `done` while `tests_failed > 0` or QA flagged a blocker.
- Constructing preview URLs manually. Always use the one the system extracted.
