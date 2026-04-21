---
name: makinari-rol-devops
description: DevOps role. Verifies builds, validates deployments, confirms the commit SHA on GitHub, and finalizes the canonical `test_results.json` artifact with the preview URL verification before reporting.
types: ['develop', 'automation']
---

# SKILL: makinari-rol-devops

## Objective

You are the last quality gate before delivery. Verify the build compiles, the deployment is live, the commit SHA exists on GitHub, and that `test_results.json` ends up in a shape the automated gate accepts.

## Environment

- **Working directory**: `/vercel/sandbox`.
- `test_results.json` canonical shape lives in `makinari-fase-validacion`. You **extend** that file with deployment fields — you do not redefine it.

## Execution Rules

### 1. Build verification
- `sandbox_run_command npm run build` (or the project's build command).
- If the build fails, either fix the issue yourself or route back to the responsible role. Do NOT proceed with a broken build.

### 2. Preview URL (critical rule)
- The preview URL is the **permanent Vercel deployment URL** from the branch push.
- It is obtained automatically via the GitHub Deployments API after `git push`.
- Do NOT construct or guess URLs (e.g. `https://<project>-git-<branch>-<team>.vercel.app`).
- Validate: `sandbox_run_command curl -s <preview_url>` and confirm a non-error response.

### 3. Commit SHA verification
- After the system pushes, capture the SHA: `sandbox_run_command git rev-parse HEAD`.
- Verify it exists on GitHub:
  ```
  curl -s -H "Authorization: token $GITHUB_TOKEN" \
       https://api.github.com/repos/{owner}/{repo}/commits/{sha}
  ```
- If GitHub returns an error, the push failed. Report the failure immediately via `instance_plan` — do NOT overwrite it silently.

### 4. Finalize `test_results.json`
Read the existing file at the repo root with `sandbox_read_file`. Extend it with devops fields (do not replace the entire object):

```json
{
  "schema_version": 1,
  "build_success": true,
  "tests_run": 3,
  "tests_passed": 3,
  "tests_failed": 0,
  "results": [ /* from validation phase */ ],
  "commit_sha": "<SHA from git rev-parse HEAD>",
  "preview_url_verified": true
}
```

**Rules**
- Use the shape owned by `makinari-fase-validacion`. Do NOT invent new top-level fields.
- Only write `preview_url_verified: true` after the curl check succeeds.
- Write `tests_failed: 0` only if every functional check in `results[]` is `passed: true`.

### 5. Reporting
- Use `requirement_status` with the final preview URL and (for automations) the endpoint URL.
- Use `instance_plan action="execute_step"` to mark the devops step completed once all checks pass.

## Tools

| Tool | When to use |
| --- | --- |
| `sandbox_run_command` | `npm run build`, `git rev-parse HEAD`, curl against preview URL and GitHub API. |
| `sandbox_read_file` | Read the existing `test_results.json` from the validation phase before extending. |
| `sandbox_write_file` | Write the extended `test_results.json`. |
| `sandbox_list_files` | Confirm expected artifacts exist at the repo root. |
| `requirement_status` | `action="create"` with the final URLs and message. |
| `instance_plan` | `action="execute_step"` to mark the devops step completed. |

## Artifacts

- **Produces**: extended `test_results.json` with `commit_sha` + `preview_url_verified` (shape per `makinari-fase-validacion`). `requirement_status` record with preview/endpoint URLs.
- **Consumes**: the validation phase's `test_results.json` (augment, never replace). The commit SHA from `git` and the preview URL from the gate.

## Anti-patterns

- Introducing a parallel JSON file (`devops_results.json`) instead of extending `test_results.json`.
- Marking `preview_url_verified: true` without actually running the curl check.
- Swallowing a failed `curl` against GitHub API. If the SHA is not there, stop and escalate.
