---
name: makinari-fase-validacion
description: Validation phase. Verify builds, test endpoints, and ensure deliverables meet quality standards before reporting.
types: ['develop', 'automation', 'content', 'design', 'task', 'integration']
---

# SKILL: makinari-fase-validacion

## Objective
"Prove it works." Ensure the quality of every deliverable before reporting it as complete.

## Execution Rules

### 1. Frontend Validation (Apps/Develop)
- Run `sandbox_run_command` with `npm run build` in the sandbox.
- Fix all TypeScript, linter, and import errors.
- The permanent preview URL is extracted automatically by the system from the GitHub Deployments API after push. Do NOT guess it.
- After deployment, validate with: `sandbox_run_command` with `curl -s <preview_url>` to confirm it is live.

### 2. Backend Validation (Automations)
- Every automation MUST have `?mode=test` support.
- Test your endpoint using `sandbox_run_command` with curl:
  ```
  curl -s "<endpoint_url>?mode=test"
  ```
- Verify it returns a successful response without mutating the database.

### 3. Content Validation
- Verify the text matches the brand tone from the investigation phase.
- Check that the content is complete (no placeholders, no Lorem Ipsum).

### 4. Test Results Artifact
- Generate `test_results.json` at the repo root using `sandbox_write_file`:
  ```json
  {
    "tests_run": 2,
    "tests_passed": 2,
    "tests_failed": 0,
    "build_success": true
  }
  ```
- Only proceed to reporting if `tests_failed` is 0.
