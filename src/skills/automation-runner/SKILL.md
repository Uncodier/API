---
name: automation-runner
description: Lightweight runner playbook for one-shot code automations in the Vercel Sandbox. Use only when the requirement is a single script that emits a result (no endpoint, no runner UI). For full automations with endpoints and a runner UI, use `makinari-obj-automatizacion` instead.
types: ['automation', 'task']
---

# SKILL: automation-runner

## Objective

Run an arbitrary, one-shot automation script in the Vercel Sandbox and surface its result. This is the **narrow** variant of automation work. If the requirement needs a deployed endpoint, a `?mode=test`/`?mode=prod` contract, or a runner UI (Vitrina), do NOT use this skill — hand off to `makinari-obj-automatizacion` which covers the full flow.

## When to use this skill

Use **this** skill only when:
- The task is a single script invocation (data transform, bulk email, file generation).
- The output is a file, a log, or a delivery URL — not a recurring endpoint.
- There is no `?mode=test`/`?mode=prod` contract to honor.

Use `makinari-obj-automatizacion` instead when:
- The client needs an HTTP endpoint they (or another system) will call repeatedly.
- The requirement declares request/response contracts in section 6.1.
- A runner UI (Vitrina) must be deployed.

## Execution Rules

### 1. Read the requirement carefully
- `requirements action="read"` — confirm this is truly a one-shot, not an endpoint in disguise.
- If any field hints at "call later", "webhook", or "trigger from UI", escalate to `makinari-obj-automatizacion`.

### 2. Write and run the script
- `sandbox_write_file` under `/vercel/sandbox` (e.g. `scripts/run.ts` or `scripts/run.py`).
- Install deps with `sandbox_run_command npm install` / `pip install` only if the script needs them.
- Execute with `sandbox_run_command` and capture output. Never discard stderr.

### 3. Debug on failure
- If the script errors, read the traceback and fix the script. Do NOT wrap failures in catch blocks just to report success.

### 4. Deliver the result
- If the output is a file, upload it somewhere the client can reach (Supabase bucket, Vitrina `data.json`, Markdown report via `makinari-obj-tarea`).
- `requirement_status action="create"` with:
  - `preview_url` (if a deliverable URL exists) OR a link to the stored artifact.
  - `message` following the template in `makinari-fase-reporteado`.

## Tools

| Tool | When to use |
| --- | --- |
| `sandbox_write_file` | Create the automation script and any intermediate files. |
| `sandbox_run_command` | Execute the script, install deps, read-only git. |
| `sandbox_read_file` | Inspect inputs and outputs. |
| `requirements` | Confirm scope. Escalate to `makinari-obj-automatizacion` when the scope grows beyond one-shot. |
| `requirement_status` | Report the final deliverable URL + message. |
| `instance_plan` | Report step status. |

## Artifacts

- **Produces**: the script file (committed), captured stdout/stderr in `step_output`, any delivery URL the script creates.
- **Consumes**: `requirement.instructions` sections 3 (Goals) and 4 (Non-Goals). Inputs declared in section 2 (Baseline).

## See also

- `makinari-obj-automatizacion` — full automation with endpoints + runner UI.
- `makinari-obj-tarea` — one-off task with Markdown Vitrina deliverable.
