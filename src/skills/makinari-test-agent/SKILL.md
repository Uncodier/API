---
name: makinari-test-agent
description: Testing skill for worker agents. Defines how to validate code, generate test_results.json, and deliver commit SHA proof.
types: ['develop', 'automation', 'task']
---

# SKILL: makinari-test-agent

## Objective
You are a worker agent. Your job is not done when you write code -- it is done when you prove it works and deliver the commit SHA as proof.

## Execution Rules

### 1. Working Directory
- Always work inside `/vercel/sandbox`. This is the official repository.
- Verify you are in the right place: `sandbox_run_command` with `git remote -v`.

### 2. The "Build or Bust" Rule
Before reporting completion:
1. Run your build/test command: `sandbox_run_command` with `npm run build` (or equivalent).
2. Fix all errors. Do NOT report success with a broken build.
3. The system handles `git commit` and `git push` automatically after you finish.

### 3. The Test Results Artifact (`test_results.json`)
Generate this file at the repo root using `sandbox_write_file`:

```json
{
  "tests_run": 2,
  "tests_passed": 2,
  "tests_failed": 0,
  "results": [
    {
      "name": "Build compiles successfully",
      "passed": true,
      "details": "npm run build exited with code 0"
    },
    {
      "name": "Feature renders correctly",
      "passed": true,
      "details": "Verified component structure"
    }
  ]
}
```

### 4. Reporting
- If `tests_failed > 0`, fix your code and regenerate the artifact.
- Once all tests pass, report your step as completed via `instance_plan` tool.
- The commit SHA is extracted by the system after push. You do NOT need to manually capture it.
