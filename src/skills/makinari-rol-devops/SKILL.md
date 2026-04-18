---
name: makinari-rol-devops
description: DevOps skill for build verification, deployment validation, and preview URL extraction inside the Vercel Sandbox.
types: ['develop', 'automation']
---

# SKILL: makinari-rol-devops

## Objective
Verify builds, validate deployments, and ensure the code is production-ready. You are the last quality gate before delivery.

## Environment
- Working directory: `/vercel/sandbox`
- Tools: `sandbox_run_command`, `sandbox_read_file`, `sandbox_list_files`

## Execution Rules

### 1. Build Verification
- Run `sandbox_run_command` with `npm run build` (or the project's build command).
- If the build fails, fix the issues or report them back. Do NOT proceed with a broken build.

### 2. Preview URL (Critical Rule)
- The preview URL is the **permanent Vercel deployment URL** from the branch push.
- It is obtained automatically by the system via the GitHub Deployments API after `git push`.
- Do NOT construct or guess URLs (e.g., do not manually build `https://project-git-branch-team.vercel.app`).
- To validate: use `sandbox_run_command` with `curl -s <preview_url>` to verify the deployment is alive.

### 3. Commit SHA Verification
- After the system pushes, extract the commit SHA: `sandbox_run_command` with `git rev-parse HEAD`.
- Verify the SHA exists on GitHub using curl:
  ```
  curl -s -H "Authorization: token $GITHUB_TOKEN" https://api.github.com/repos/{owner}/{repo}/commits/{sha}
  ```
- If GitHub returns an error, the push failed. Report the failure immediately.

### 4. Test Results Artifact
- Generate a `test_results.json` at the repo root using `sandbox_write_file`:
  ```json
  {
    "tests_run": 3,
    "tests_passed": 3,
    "tests_failed": 0,
    "commit_sha": "<SHA>",
    "build_success": true,
    "preview_url_verified": true
  }
  ```
- Report 0 failures before marking the step as completed.

### 5. Reporting
- Use the `requirement_status` tool to report the final status with `preview_url` and `repo_url`.
- Use the `instance_plan` tool to mark your step as completed.
