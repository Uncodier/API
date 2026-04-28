---
name: makinari-fase-planeacion
description: Planning phase. Translates a ready requirement and investigation output into an `instance_plan` with typed steps, each bound to a skill, ordered to clear the automated gate.
types: ['develop', 'automation', 'content', 'design', 'task', 'integration', 'planning']
---

# SKILL: makinari-fase-planeacion

## Objective

"Map the path before walking." Turn the requirement contract and investigation findings into a concrete `instance_plan`. Understand the hierarchy: You are taking **ONE Backlog Item** and breaking it down into a sequence of execution steps (the `instance_plan`). A good plan (a) covers every Acceptance Criterion of the current Backlog Item, (b) binds each step to the correct skill (Frontend, Backend, QA, etc.), (c) orders steps so the automated gate passes, and (d) never duplicates an existing active plan.

## Execution Rules

### 0. Read the backlog first (WIP=1)
`requirement_backlog action="list"` is the **first** tool call. The plan you
build this cycle MAY ONLY work on **one pending item** (WIP=1) from the
**current phase**. If the backlog shows another item already `in_progress`,
resume it instead of creating a new plan step. Plans that touch `done` items
or items from future phases are rejected by the coordinator.

### 1. Read the remaining inputs
- `requirements action="read"` — load the immutable spec (`requirement.spec.md`
  in the repo, or the `instructions` field in DB). Do NOT rewrite the spec.
- Read `progress.md` and the last entries of `DECISIONS.md` for assumptions
  already accepted.
- Read the `## Investigation` section (or `INVESTIGATION.md`) left by
  `makinari-fase-investigacion`.
- `instance_plan action="list"` — do NOT create a new plan if an active one
  exists. Continue its pending steps instead.

### 2. Plan rubric — "is this a good plan?"
Before calling `instance_plan action="create"`, verify:

- [ ] If the requirement targets the applications repo, **step 1 selects the base** via `makinari-obj-template-selection` (unless `instructions` already declares `BASE: ...` from a prior cycle).
- [ ] Investigation is either already done (step exists and is completed) OR is step 2.
- [ ] Every Acceptance Criterion maps to at least one step's `instructions`.
- [ ] Development steps (`makinari-rol-frontend` / `makinari-rol-backend` / `makinari-rol-content`) are followed by **one QA step** using `makinari-rol-qa`.
- [ ] Validation (`makinari-fase-validacion`) runs before reporting.
- [ ] Reporting (`makinari-fase-reporteado`) is the final step.
- [ ] Each step names either `skill` (preferred) or `role`. Never leave both empty.
- [ ] Each step specifies `expected_output` defining exactly what artifact or state change proves the step succeeded.
- [ ] Each step specifies `success_criteria` (array of strings) with concrete, observable checks for the step.
- [ ] Each step specifies `validation_rules` (array of strings) to prevent regressions or anti-patterns during the step.
- [ ] `instructions` on each step is concrete (specific files, specific endpoints, exact UI screens, navigation flows, specific assertions). For frontend steps, explicitly describe the UI layout, components to use (e.g., Shadcn UI Cards, Dialogs, Tables), and responsive behavior — no "implement the feature" or "build the UI". Eliminate ambiguity.

### 3. Plan templates by requirement type

**Develop (frontend-led feature)**

```json
{
  "action": "create",
  "title": "Implement: <requirement_title>",
  "description": "End-to-end plan to deliver the backlog item.",
  "expected_output": "Working feature deployed to preview URL.",
  "success_criteria": ["All acceptance criteria met", "QA scenarios pass", "Build succeeds"],
  "validation_rules": ["No mocked data", "Must use Shadcn UI"],
  "steps": [
    { 
      "id": "step_base", 
      "order": 1, 
      "title": "Project base", 
      "skill": "makinari-obj-template-selection", 
      "instructions": "Pick Vitrina vs generic app per req section 8; git checkout; append BASE: <branch> to instructions.",
      "expected_output": "Branch checked out and BASE appended to instructions.",
      "success_criteria": ["git status shows clean working tree on feature branch"],
      "validation_rules": ["Do not overwrite existing BASE if present"]
    },
    { 
      "id": "step_invest", 
      "order": 2, 
      "title": "Investigation", 
      "skill": "makinari-fase-investigacion", 
      "instructions": "Produce Investigation section per output contract.",
      "expected_output": "Investigation context gathered for downstream steps.",
      "success_criteria": ["Dependencies verified"],
      "validation_rules": ["Do not write code in this step"]
    },
    { 
      "id": "step_fe", 
      "order": 3, 
      "title": "Frontend", 
      "skill": "makinari-rol-frontend", 
      "instructions": "Implement routes <list>, expose data-testids per req section 6.4, wire real handlers. explicitly describe the UI layout, components to use (e.g., Shadcn UI Cards, Dialogs, Tables), and responsive behavior.",
      "expected_output": "UI components and pages created and wired to real endpoints.",
      "success_criteria": ["Pages render without 500 errors", "Shadcn components used for layout", "Responsive on mobile"],
      "validation_rules": ["No mocked data", "Must use Tailwind classes"]
    },
    { 
      "id": "step_qa", 
      "order": 4, 
      "title": "QA", 
      "skill": "makinari-rol-qa", 
      "instructions": "Author .qa/scenarios per req section 6.5, triage gate signals, write qa_results.json.",
      "expected_output": "qa_results.json written with passing scenarios.",
      "success_criteria": ["All scenarios pass", "No 503 errors on boot"],
      "validation_rules": ["Scenarios must target real DOM test-ids"]
    },
    { 
      "id": "step_val", 
      "order": 5, 
      "title": "Validation", 
      "skill": "makinari-fase-validacion", 
      "instructions": "npm run build, verify preview, write test_results.json.",
      "expected_output": "test_results.json written with build success.",
      "success_criteria": ["npm run build exits with 0"],
      "validation_rules": ["Must not skip type checking"]
    },
    { 
      "id": "step_report", 
      "order": 6, 
      "title": "Report", 
      "skill": "makinari-fase-reporteado", 
      "instructions": "Create requirement_status with preview URL.",
      "expected_output": "requirement_status created in DB.",
      "success_criteria": ["Preview URL is valid and reachable"],
      "validation_rules": ["Do not report success if build failed"]
    }
  ]
}
```

**Automation (backend webhook + runner UI)**

```json
{
  "action": "create",
  "title": "Automation: <title>",
  "steps": [
    { "id": "step_base", "order": 1, "skill": "makinari-obj-template-selection", "instructions": "Select automation runner Vitrina branch." },
    { "id": "step_invest", "order": 2, "skill": "makinari-fase-investigacion", "instructions": "Confirm endpoint shape + env vars per req section 6.1 and 6.3." },
    { "id": "step_be", "order": 3, "skill": "makinari-rol-backend", "test_command": "npm run test:backend", "instructions": "Implement endpoint with ?mode=test and ?mode=prod per req section 6.1." },
    { "id": "step_obj", "order": 4, "skill": "makinari-obj-automatizacion", "instructions": "Inject runner UI via Vitrina data.json." },
    { "id": "step_qa", "order": 5, "skill": "makinari-rol-qa", "instructions": "Scenario exercises mode=test from the runner UI and asserts response shape." },
    { "id": "step_val", "order": 6, "skill": "makinari-fase-validacion", "instructions": "curl mode=test, write test_results.json." },
    { "id": "step_devops", "order": 7, "skill": "makinari-rol-devops", "instructions": "Verify SHA on GitHub, extend test_results.json with commit_sha and preview_url_verified." },
    { "id": "step_report", "order": 8, "skill": "makinari-fase-reporteado", "instructions": "Create requirement_status with endpoint_url and preview_url." }
  ]
}
```

**Content (article / blog / copy)**

```json
{
  "action": "create",
  "title": "Content: <title>",
  "steps": [
    { "id": "step_invest", "order": 1, "skill": "makinari-fase-investigacion", "instructions": "Pull brand tone from memories + site settings." },
    { "id": "step_content", "order": 2, "skill": "makinari-rol-content", "instructions": "Author final content per req section 5 and brand guidelines." },
    { "id": "step_val", "order": 3, "skill": "makinari-fase-validacion", "instructions": "Verify tone, no placeholders, structural rules met." },
    { "id": "step_report", "order": 4, "skill": "makinari-fase-reporteado", "instructions": "Create requirement_status linking to the delivered content." }
  ]
}
```

**Task (one-off script + Markdown Vitrina)**

```json
{
  "action": "create",
  "title": "Task: <title>",
  "steps": [
    { "id": "step_base", "order": 1, "skill": "makinari-obj-template-selection", "instructions": "Select text/Markdown Vitrina branch." },
    { "id": "step_task", "order": 2, "skill": "makinari-obj-tarea", "instructions": "Write the script, execute it, format output as Markdown and inject into data.json." },
    { "id": "step_val", "order": 3, "skill": "makinari-fase-validacion", "instructions": "Verify preview URL loads and shows the report." },
    { "id": "step_report", "order": 4, "skill": "makinari-fase-reporteado", "instructions": "Create requirement_status with Vitrina URL + execution metrics." }
  ]
}
```

### 4. Hand-off safety
- **Developer steps** must tell the worker to run the build / test command before completion.
- **DevOps step** must verify the commit SHA on GitHub before declaring success.
- **QA step** must reference the test-id contract from requirement section 6.4.

### 5. Sync the requirement brain
As the plan is refined, update `requirement.instructions` via `requirements action="update"` so the "Execution Plan" checklist (section 9) mirrors the live plan. Optionally mirror the plan as `REQUIREMENT.md` via `sandbox_write_file`.

## Tools

| Tool | When to use |
| --- | --- |
| `requirements` | Read the requirement; append the plan summary to the Execution Plan section. |
| `instance_plan` | `action="list"` to dedupe; `action="create"` to submit the plan. |
| `sandbox_read_file` | Confirm investigation artifacts before planning. |
| `sandbox_write_file` | Optional: snapshot `REQUIREMENT.md`. |
| `memories` | Recall prior plan patterns for the same site when useful. |

## Artifacts

- **Produces**: an `instance_plan` record (DB) with ordered steps, each binding to a `skill` (preferred) or `role`. Optionally updates `requirement.instructions` section 9.
- **Consumes**: `requirement.instructions` (sections 6, 7, 8, 10), Investigation output, existing plans via `instance_plan action="list"`.

## Anti-patterns

- Creating a plan while an active one exists. Always `list` first.
- Vague `instructions` like "implement the feature". Always name files, endpoints, or acceptance criteria.
- Skipping QA when the requirement ships UI.
- Adding steps for skills that don't exist. Confirm via `skill_lookup` if unsure.
