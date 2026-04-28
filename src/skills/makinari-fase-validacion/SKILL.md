---
name: makinari-fase-validacion
description: Validation phase. Verifies builds, tests endpoints, and owns the canonical `test_results.json` artifact the automated gate consumes before reporting.
types: ['develop', 'automation', 'content', 'design', 'task', 'integration']
---

# SKILL: makinari-fase-validacion

## Objective

"Prove it works." This phase runs after development and QA, before reporting. Ensure every deliverable meets the acceptance criteria, the build compiles, and the canonical `test_results.json` artifact exists so the automated gate can unblock the next step.

This skill is the **source of truth** for the `test_results.json` shape. `makinari-rol-devops`, `makinari-test-agent`, and the automated gate all read the same shape defined here.

## Status: Consumer-only (deprecated as Judge)

Starting with the harness refactor, `makinari-fase-validacion` is a **Consumer** skill: it produces `test_results.json` and pushes evidence (build / runtime / scenarios) to the runner. It **no longer decides** if a backlog item is `done`. That decision belongs to `makinari-rol-judge` (and per-flow `makinari-rol-judge-app/-doc/-slides/-contract/-backend/-task`). Do not write `status: 'done'` from this skill; only write to evidence.

## Execution Rules

### 1. Validate the frontend (develop / apps)
1. `sandbox_run_command npm run build`. Fix every TypeScript, ESLint, and import error.
2. Check the permanent preview URL — it is extracted automatically from the GitHub Deployments API after push. Do NOT guess or construct it.
3. After deployment: `sandbox_run_command curl -s <preview_url>` to confirm the deployment is alive. **CRITICAL: You MUST inspect the HTML response body. If the body contains "404", "This page could not be found", or "Application error", the deployment is broken. A 200 OK HTTP status is not enough if the page renders a Next.js error.**
4. CRITICAL: For transactional features, you MUST verify that the frontend actually integrates with the backend and database. Do NOT accept mock data or hardcoded responses.

### 2. Validate the backend (automations / endpoints)
1. Every endpoint MUST accept `?mode=test`. Call it: `sandbox_run_command curl -s "<endpoint_url>?mode=test"`.
2. Verify the response matches the canonical backend shape (`{ ok: true, mode: "test", data: ... }` — see `makinari-rol-backend`).
3. Confirm no DB mutation happened in test mode (by querying a known count or by reading audit logs).
4. CRITICAL: Verify that the endpoint actually performs the requested database operations when not in test mode. Do NOT accept mock responses.
5. CRITICAL: For authentication endpoints (login, signup, session), verify that they actually authenticate the user and return valid session tokens/cookies. Do NOT accept mock responses.

### 3. Validate content deliverables
- Verify copy matches the brand tone captured during investigation.
- Check that content is complete: no placeholders, no Lorem Ipsum, no TODOs.
- Verify structural elements required by the requirement (headings, callouts, links).

### 4. Write the canonical `test_results.json` artifact
Write this file at the **repo root** using `sandbox_write_file`. The automated gate and the orchestrator both consume it. Other skills (`makinari-rol-devops`, `makinari-test-agent`) MUST write the same shape.

**Canonical shape**

```json
{
  "schema_version": 1,
  "build_success": true,
  "tests_run": 3,
  "tests_passed": 3,
  "tests_failed": 0,
  "results": [
    {
      "name": "Build compiles successfully",
      "passed": true,
      "details": "npm run build exited with code 0"
    },
    {
      "name": "Endpoint /api/example mode=test",
      "passed": true,
      "details": "HTTP 200, shape {ok:true,mode:'test'} verified"
    },
    {
      "name": "Home route responds 200",
      "passed": true,
      "details": "curl -s https://<preview>/ → 200"
    }
  ],
  "commit_sha": "<filled by devops after push, optional in earlier phases>",
  "preview_url_verified": true
}
```

**Field reference**

| Field | Required | Owner | Meaning |
| --- | --- | --- | --- |
| `schema_version` | yes | validation | Always `1` for this shape. Bump only via this skill. |
| `build_success` | yes | validation | `npm run build` (or the project's build command) exited 0. |
| `tests_run` | yes | validation | Total number of validation checks attempted. |
| `tests_passed` | yes | validation | Checks that passed. |
| `tests_failed` | yes | validation | Checks that failed. MUST be `0` to proceed to reporting. |
| `results[]` | yes | validation | Per-check detail. Include at minimum build + one functional check. |
| `commit_sha` | no | devops | Filled by `makinari-rol-devops` after push. |
| `preview_url_verified` | no | devops | Set to `true` by devops after the preview URL is reachable. |

**Rules**
- Unknown fields MAY be added by downstream skills but must not clash with the ones above.
- If a downstream skill needs a NEW required field, update this skill first, bump `schema_version`, and announce in the requirement `## Revisions` section.
- QA coverage does NOT go here — it belongs in `qa_results.json` owned by `makinari-rol-qa`.

### 5. Only proceed to reporting if `tests_failed === 0`
If any check fails, go back to the role that owns it (frontend / backend / content) with a specific defect — do not report.

## Tools

| Tool | When to use |
| --- | --- |
| `sandbox_run_command` | `npm run build`, curl smokes, `git rev-parse HEAD`. |
| `sandbox_write_file` | Write `test_results.json` at the repo root. |
| `sandbox_read_file` | Inspect existing `test_results.json` if a previous phase left one. |
| `sandbox_list_files` | Confirm expected deliverables (e.g. page files, SQL migrations) exist. |
| `instance_plan` | Report step status via `action="execute_step"`. |

## Artifacts

- **Produces**: `test_results.json` at the repo root (canonical shape defined above).
- **Consumes**: `requirement.instructions` section 7 (Acceptance Criteria). Build output from the sandbox. Deployment URL from the gate.

## Anti-patterns

- Diverging `test_results.json` shapes across skills. If you need different fields, extend this skill.
- Marking `tests_failed=0` when the build actually warned or the preview returned 500. The gate will catch you; integrity first.
- Writing this artifact from QA's perspective. QA owns `qa_results.json`; this file is about build + functional validation.
