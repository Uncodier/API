---
name: makinari-obj-automatizacion
description: Objective skill for delivering backend automations with endpoints, test/prod modes, and a frontend runner interface (Vitrina).
types: ['automation', 'integration']
---

# SKILL: makinari-obj-automatizacion

## Objective
Deliver backend automations (webhooks, scripts, endpoints) with a test interface (Vitrina).

## Execution Rules

### 1. Repository Structure
- Code goes under `clients/{site_id}/{req_id}/` in the repo at `/vercel/sandbox`.
- Use `sandbox_write_file` to create files and `sandbox_run_command` to install dependencies.

### 2. Mode Support (Critical)
- `?mode=test`: Execute WITHOUT API Key (auth bypass). No database mutations. Return mock success or test data.
- `?mode=prod`: Require API Key via Authorization header. Perform real operations.

### 3. Frontend Interface (Vitrina)
- Provide a runner UI so the client can execute the automation manually.
- Use the Vitrina template branch (see `makinari-obj-vitrinas` skill for branch mappings).
- The Vitrina includes: API Key input, Test/Prod mode buttons, response viewer, and execution history.

### 4. Delivery
- `requirement_status` must include:
  - `endpoint_url`: The backend automation URL (validated with `?mode=test`).
  - `preview_url`: The Vitrina frontend URL (permanent Vercel deployment from branch push).
- The workspace archive is uploaded on each `sandbox_push_checkpoint` (and after `sandbox_restore_checkpoint`).

### 5. Robustness
- Validate payloads defensively (handle missing fields without crashing).
- Test with a simulated payload via `sandbox_run_command` with curl before delivery.
