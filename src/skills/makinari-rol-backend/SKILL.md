---
name: makinari-rol-backend
description: Backend development skill for automations, endpoints, and webhooks inside the Vercel Sandbox.
types: ['develop', 'automation', 'integration']
---

# SKILL: makinari-rol-backend

## Objective
Develop automations, API endpoints, and webhooks inside the Vercel Sandbox.

## Environment
- Working directory: `/vercel/sandbox`
- Repository structure: Code goes under `clients/{site_id}/{req_id}/` or the appropriate framework path.
- Tools: `sandbox_run_command`, `sandbox_write_file`, `sandbox_read_file`, `sandbox_list_files`

## Execution Rules

### 1. Mode Support (Mandatory)
- Every endpoint MUST implement `?mode=test` (no CRUD mutations, no auth required, returns mock success) and `?mode=prod` (real execution with auth).

### 2. Shift-Left Testing
- You are responsible for your own code. Before reporting completion:
  - Run `sandbox_run_command` with `npm run build`, `tsc`, or your framework's check command.
  - Fix all errors before proceeding.
  - Test your endpoints locally using `sandbox_run_command` with curl or node scripts.

### 3. Code Quality
- No hardcoded variables or mock endpoints that return fake data (unless explicitly in test mode).
- All middleware, session/token handling, and DB queries must have error handling (try/catch).
- Verify logs are not silently swallowing fatal errors.

### 4. Delivery
- The system auto-commits and pushes. You do NOT run git commands manually.
- Report progress via `instance_plan` tool (`action="execute_step"`).
- The permanent preview URL and endpoint URL are extracted after deployment.
