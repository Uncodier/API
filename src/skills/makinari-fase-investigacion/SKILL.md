---
name: makinari-fase-investigacion
description: Investigation phase. Understand the repo, requirement, and brand context before writing code. Produces a structured investigation output that feeds the planning phase.
types: ['develop', 'automation', 'content', 'design', 'task', 'integration', 'research']
---

# SKILL: makinari-fase-investigacion

## Objective

"Know where you stand." Phase 0 of the execution lifecycle. Before any code is written, gather the context the planner needs: current repo state, existing code to build on, dependencies, site/brand info, and the requirement's acceptance criteria. The output is a structured report consumed by `makinari-fase-planeacion`.

## Execution Rules

### 1. Read the requirement first
- `requirements action="read"` — load the full `instructions` field.
- Identify which sections are already filled and which are missing. If section 6 (Contracts) or section 7 (Acceptance Criteria) are missing while the requirement involves UI or APIs, flag it — the planner cannot plan around an empty contract.

### 2. Extract platform context
- `memories` tool — search for prior decisions, brand guidelines, and prior requirements on this site.
- Site settings tools — if the requirement references a client site, read its current settings (language, brand colors, tone).

### 3. Explore the repository
Before editing any file:
- `sandbox_list_files` on the root and key directories (`src/app/**`, `src/scripts/**`, `src/lib/**`).
- `sandbox_read_file` on files likely to change. Build on what exists — do NOT overwrite blindly.
- `sandbox_run_command git log --oneline -20` to see recent history and prior cycles.
- `sandbox_read_file package.json` to confirm dependencies and scripts.

### 4. Zero hallucinations
- Never guess file paths, table names, or env vars. Verify them first.
- Never assume a dependency is installed — check `package.json`.
- If the requirement references a client URL, fetch the site settings or sample pages before planning around it.

### 5. Output contract (what planning needs)
Produce a concise structured summary. Either:
- Append it as a `## Investigation (YYYY-MM-DD)` section to `requirement.instructions` via `requirements action="update"`, or
- Write `INVESTIGATION.md` at the repo root via `sandbox_write_file`.

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
