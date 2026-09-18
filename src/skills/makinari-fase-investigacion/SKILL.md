---
name: makinari-fase-investigacion
description: Investigation phase. Understand the repo, requirement, and brand context before writing code. Produces a structured investigation output that feeds the planning phase.
types: ['develop', 'automation', 'content', 'design', 'task', 'integration', 'research']
---

# SKILL: makinari-fase-investigacion

## Objective

"Know where you stand." Phase 0 of the execution lifecycle. Before any code is written, gather the context the planner needs: current repo state, existing code to build on, dependencies, site/brand info, and the requirement's acceptance criteria. The output is a structured report consumed by `makinari-fase-planeacion`.

## Execution Rules

### 0. Bounded investigation and stop conditions
- Investigation answers one concrete question; it is not an open-ended search for possible defects.
- Treat historical failures as leads, not as proof that the failure still exists.
- Run each targeted diagnostic command or runtime probe at most once unless its inputs changed.
- Do not reread an unchanged file. Use the prior tool result already present in the step history.
- A passing targeted test plus a passing relevant runtime probe is sufficient evidence that a historical failure is currently **not reproducible**. "Not reproducible with current evidence" is a valid terminal diagnosis.
- Use at most 6 investigation tool calls. On the next turn, report the evidence-backed conclusion and call `instance_plan action="execute_step" step_status="completed"`.
- If one concrete unknown remains after the budget, report it and call `instance_plan action="execute_step" step_status="failed"`; do not continue exploring indefinitely.
- Read-only investigations do not require a checkpoint. A checkpoint is required only when files were modified.

### 1. Read the requirement first
- `requirements action="read"` — load the full `instructions` field.
- Identify which sections are already filled and which are missing. If section 6 (Contracts) or section 7 (Acceptance Criteria) are missing while the requirement involves UI or APIs, flag it — the planner cannot plan around an empty contract.

### 2. Extract platform context
- **CRITICAL - Company Background**: You MUST always search for the company's background, context, and brand identity using the `memories` tool and `instance_logs` or `tools(action="call", name="instance")` before designing requirements, backlogs, or plans. Align the investigation with the company's core objectives and target audience.
- `memories` tool — search for prior decisions, brand guidelines, and prior requirements on this site.
- Site settings tools — if the requirement references a client site, read its current settings (language, brand colors, tone).

### 3. Explore the repository
Before editing any file:
- `sandbox_list_files` on the root and key directories (`src/app/**`, `src/scripts/**`, `src/lib/**`).
- `sandbox_read_file` on files likely to change. Build on what exists — do NOT overwrite blindly.
- `sandbox_run_command git log --oneline -20` to see recent history and prior cycles.
- `sandbox_read_file package.json` to confirm dependencies and scripts.
- **Note on Repositories**: Read `REQUIREMENT_MAPPINGS.md` at the root of the API repo if you need to understand how the system routes the current requirement type to the underlying repository (`GIT_APPLICATIONS_REPO` vs `GIT_AUTOMATIONS_REPO`) and the corresponding branch.

### 4. Zero hallucinations
- Never guess file paths, table names, or env vars. Verify them first.
- Never assume a dependency is installed — check `package.json`.
- If the requirement references a client URL, fetch the site settings or sample pages before planning around it.

### 5. Output contract (what planning needs)
Produce a concise structured summary. Either:
- Append it as a `## Investigation (YYYY-MM-DD)` section to `requirement.instructions` via `requirements action="update"`, or
- Write `INVESTIGATION.md` at the repo root via `sandbox_write_file`.

When the step is investigating an already implemented feature or a historical
failure, prefer returning the structured summary in `step_output`; do not
create or rewrite repository documentation unless the step explicitly asks
for a durable artifact.

**Template**

```markdown
## Investigation

### Current state
- Branch: `<name>` (or "not yet selected")
- Key files touching this feature:
  - `path/to/file.ts` — brief role
- Existing behavior: 1-2 lines describing what the code does today.

### Dependencies in play
- `next@<version>`, `@supabase/supabase-js@<version>`, ...
- Any missing dependency the feature needs.

### Data model
- Tables / columns involved and whether this cycle mutates them.

### Risks and unknowns
- Things the requirement assumes that the repo does not confirm.
- Points where the Contract (req section 6) conflicts with reality.

### Recommended base
- Confirm or override the Base Hint (req section 8). Reason in one line.

### Open questions
- Concrete blockers for planning. Flag CRITICAL vs nice-to-have.
```

### 6. Handshake to planning
The planner will quote the "Current state", "Data model", and "Recommended base" sections when building `instance_plan` steps. Keep the output compact and factual — no narrative, no speculation.

Your final action must be `instance_plan action="execute_step"` with:
- `step_status="completed"` when the question was answered, including when the historical failure is not reproducible.
- `step_status="failed"` only when a named unknown still blocks planning after the tool budget.
- `step_output` containing the files inspected, commands/probes executed once, observed results, conclusion, and recommended next action.

## Tools

| Tool | When to use |
| --- | --- |
| `requirements` | `action="read"` to load the requirement; `action="update"` to append the Investigation section. |
| `memories` | Search brand / prior decisions / historical context. |
| `sandbox_list_files` | Map the repo structure before forming an opinion. |
| `sandbox_read_file` | Inspect code and config that this cycle will touch. |
| `sandbox_run_command` | `git log --oneline -20`, `git status`, read-only diagnostics. |
| `sandbox_write_file` | Optional: write `INVESTIGATION.md` snapshot at repo root. |
| `instance_plan` | Report step status via `action="execute_step"`. |

## Artifacts

- **Produces**: Investigation summary appended to `requirement.instructions` as a `## Investigation` section (primary), optionally `INVESTIGATION.md` at repo root.
- **Consumes**: `requirement.instructions` (especially sections 2, 6, 7, 8), repo contents, `memories`, site settings.

## Anti-patterns

- Writing a narrative essay. Keep findings bulleted and factual.
- Guessing at file paths or schemas. Verify with `sandbox_read_file`.
- Skipping the "Open questions" section when ambiguity exists — silent assumptions cost downstream cycles.
- Re-running a passing test or probe to search for a different outcome.
- Continuing to search merely because the instructions mention a historical failure.
- Treating absence of a reproducible error as incomplete work.
