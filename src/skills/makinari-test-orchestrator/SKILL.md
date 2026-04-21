---
name: makinari-test-orchestrator
description: Testing playbook for the orchestrator. Defines how to validate worker deliverables using the canonical `test_results.json`, verify commit SHAs on GitHub, and approve hand-offs between steps.
types: ['develop', 'automation', 'task']
---

# SKILL: makinari-test-orchestrator

## Objective

You are the Orchestrator. This skill defines how you approve a worker step before the plan advances. Validation relies on the canonical `test_results.json` shape owned by `makinari-fase-validacion` and on the commit SHA returned by GitHub after push.

## Execution Rules

### 1. Design plans with testing baked in
When creating an `instance_plan`, include explicit testing instructions in each worker step:

> "Develop the feature. Run `npm run build` to verify. Generate `test_results.json` per `makinari-fase-validacion` with `tests_failed: 0` before marking the step completed."

### 2. Validate worker output after each step
After a worker marks a step `completed`:
1. `sandbox_read_file /vercel/sandbox/test_results.json`.
2. Verify `schema_version: 1` and `tests_failed === 0`.
3. If `tests_failed > 0` or the file is missing, do NOT proceed. Either escalate back to the worker or route a corrective step.

### 3. Verify the commit SHA on GitHub
After the system pushes:
1. `sandbox_run_command git rev-parse HEAD` to capture the SHA.
2. `sandbox_run_command curl -s -H "Authorization: token $GITHUB_TOKEN" https://api.github.com/repos/{owner}/{repo}/commits/{sha}`.
3. If GitHub returns an error, the push failed. Stop the plan and report immediately.

### 4. Verify the preview URL
- The system provides the permanent deployment URL via the GitHub Deployments API.
- `sandbox_run_command curl -s <preview_url>` to confirm it responds successfully.
- Only approve the deliverable if the URL is live.

### 5. Cross-reference QA
If the plan included a QA step, also `sandbox_read_file /vercel/sandbox/qa_results.json` and confirm `passed_last_run: true` and `testid_contract_drift: []`. These signal that QA accepts the deliverable.

### 6. Final approval
Only when ALL of the following are true:
- `test_results.json` → `tests_failed === 0` and `preview_url_verified: true`.
- `qa_results.json` (if UI ships) → `passed_last_run: true`.
- SHA verified on GitHub.
- Preview URL responded successfully.

Then create the final `requirement_status` via `makinari-fase-reporteado` and flip `requirements status="done"`.

## Tools

| Tool | When to use |
| --- | --- |
| `sandbox_read_file` | Read `test_results.json` and `qa_results.json` after each step. |
| `sandbox_run_command` | `git rev-parse HEAD`, curl GitHub API, curl preview URL. |
| `instance_plan` | `action="list"` to check plan status; `action="execute_step"` to signal approval moves. |
| `requirements` | `action="update"` to flip final status once everything is green. |
| `requirement_status` | Delegate final creation to `makinari-fase-reporteado`. |

## Artifacts

- **Produces**: approval decisions recorded via `instance_plan execute_step`; no new files.
- **Consumes**: `test_results.json` (validation / devops), `qa_results.json` (QA), GitHub SHA, preview URL.

## Anti-patterns

- Approving a step while `tests_failed > 0` because "the next step will fix it".
- Ignoring `qa_results.json` when the plan shipped UI.
- Guessing the preview URL instead of reading the one the system extracted.
