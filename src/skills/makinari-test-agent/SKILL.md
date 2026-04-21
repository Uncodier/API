---
name: makinari-test-agent
description: Testing playbook for worker agents (frontend, backend, content). Defines when a step is "done", how to prove it, and how to emit the canonical `test_results.json` artifact owned by `makinari-fase-validacion`.
types: ['develop', 'automation', 'task']
---

# SKILL: makinari-test-agent

## Objective

You are a worker agent. Your step is not done when you write code — it is done when you **prove** the code works and leave behind the artifact the gate needs to unblock the next step.

This skill defines the worker-side discipline; the canonical shape of `test_results.json` lives in `makinari-fase-validacion`.

## Execution Rules

### 1. Verify the working directory
- Always work inside `/vercel/sandbox`. This is the official repository.
- Verify: `sandbox_run_command git remote -v`.

### 2. The "Build or Bust" rule
Before reporting completion:
1. Run the build/test command: `sandbox_run_command npm run build` (or the stack's equivalent).
2. Fix every error. Do NOT report success with a broken build.
3. The system handles `git commit` and `git push` automatically after you finish. Never commit manually.

### 3. Emit `test_results.json`
Generate this file at the repo root using `sandbox_write_file`. Use the canonical shape defined in `makinari-fase-validacion`:

```json
{
  "schema_version": 1,
  "build_success": true,
  "tests_run": 2,
  "tests_passed": 2,
  "tests_failed": 0,
  "results": [
    { "name": "Build compiles successfully", "passed": true, "details": "npm run build exited with code 0" },
    { "name": "Feature renders correctly", "passed": true, "details": "Verified component structure + smoke curl" }
  ]
}
```

**Rules**
- Do NOT invent fields. If you need to report something structural, extend `makinari-fase-validacion` first.
- QA coverage is reported separately in `qa_results.json` (owned by `makinari-rol-qa`). Do not merge the two files.

### 4. If any test fails
- Fix your code and regenerate the artifact.
- Do NOT mark the step completed while `tests_failed > 0`.

### 5. Reporting
Once all tests pass, report your step as completed via `instance_plan action="execute_step"`. The commit SHA is extracted by the system after push — you do NOT need to capture it manually.

## Tools

| Tool | When to use |
| --- | --- |
| `sandbox_run_command` | `npm run build`, curl smokes, `git remote -v`. |
| `sandbox_write_file` | Write `test_results.json` at repo root. |
| `sandbox_read_file` | Inspect files you changed before declaring done. |
| `instance_plan` | Report step status via `action="execute_step"`. |

## Artifacts

- **Produces**: `test_results.json` at the repo root (shape defined by `makinari-fase-validacion`).
- **Consumes**: the requirement's Acceptance Criteria (section 7) to decide which checks to include in `results[]`.

## Anti-patterns

- Running the build once, fixing one error, and reporting success without re-running. Always run a clean pass.
- Reporting "completed" so the pipeline progresses while knowing a test is flaky.
- Inventing new fields in `test_results.json` without updating `makinari-fase-validacion`.
