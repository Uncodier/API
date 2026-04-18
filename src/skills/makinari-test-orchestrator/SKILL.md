---
name: makinari-test-orchestrator
description: Testing skill for the orchestrator. Defines how to validate worker output, verify commit SHA on GitHub, and approve hand-offs.
types: ['develop', 'automation', 'task']
---

# SKILL: makinari-test-orchestrator

## Objective
You are the Orchestrator. This skill defines how to validate worker deliverables and approve hand-offs to the next phase.

## Execution Rules

### 1. How to Design Plans with Testing
When creating an `instance_plan`, include explicit testing instructions in each worker step:
> "Develop the feature. Run `npm run build` to verify. Generate `test_results.json` with 0 failures before marking the step as completed."

### 2. Validating Worker Output
After a worker step completes:
1. Read the test artifact: `sandbox_read_file` on `/vercel/sandbox/test_results.json`.
2. Verify `tests_failed` is 0.
3. If tests failed, do NOT proceed to the next step. Report the failure.

### 3. Commit SHA Verification (Post-Push)
After the system pushes to GitHub:
1. Get the SHA: `sandbox_run_command` with `git rev-parse HEAD`.
2. Verify it exists on GitHub:
   ```
   sandbox_run_command with: curl -s -H "Authorization: token $GITHUB_TOKEN" https://api.github.com/repos/{owner}/{repo}/commits/{sha}
   ```
3. If GitHub returns an error, the push failed. Report immediately.

### 4. Preview URL Verification
- The system provides the permanent deployment URL from the GitHub Deployments API.
- Validate it is live: `sandbox_run_command` with `curl -s <preview_url>`.
- Only approve the deliverable if the URL responds successfully.

### 5. Final Approval
- Only when: tests pass, SHA is verified on GitHub, and preview URL is live.
- Then create the final `requirement_status` with all URLs and mark the requirement as `done`.
