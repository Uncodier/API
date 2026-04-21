---
name: makinari-obj-automatizacion
description: Objective skill for delivering backend automations. Ships a dual-mode endpoint (`?mode=test` / `?mode=prod`) plus a runner UI (Vitrina) so the client can execute the automation manually and verify it in test mode without side effects.
types: ['automation', 'integration']
---

# SKILL: makinari-obj-automatizacion

## Objective

Deliver a complete automation: a backend endpoint (webhook / script / scheduled task) with dual-mode contract, plus a frontend runner UI the client uses to trigger and verify it. Both surfaces ship together in the same requirement.

For one-shot scripts without an endpoint or UI, use `automation-runner` instead.

## Execution Rules

### 1. Honor the requirement contract
- Read sections 6.1 (API contracts) and 6.3 (Env vars) of `requirement.instructions`.
- Implement the endpoint exactly per the declared request / response shapes — see `makinari-rol-backend` for the canonical dual-mode response template.

### 2. Repository structure
- Automation code lives under `clients/{site_id}/{req_id}/` in the applications repo at `/vercel/sandbox`, OR under `src/app/api/**` if the requirement targets the core repo.
- Install dependencies with `sandbox_run_command npm install <pkg>` only when the requirement's section 6 allows new deps.

### 3. Dual-mode support (mandatory)
- `?mode=test`: NO auth, NO side effects (no DB mutations, no external POSTs). Returns a deterministic success envelope `{ ok: true, mode: "test", data: ... }`.
- `?mode=prod`: Requires API key via `Authorization` header. Performs the real work. Returns `{ ok: true, mode: "prod", data: ... }`.

Delegate the implementation details to `makinari-rol-backend` — this skill's job is to ensure the contract exists and the UI consumes it.

### 4. Frontend runner (Vitrina)
The client needs a UI to execute the automation manually and inspect the response:
- Use the Automation Runner Vitrina base branch (see `makinari-obj-template-selection` / `makinari-obj-vitrinas`).
- The runner must include:
  - API key input (masked).
  - Test / Prod mode toggle.
  - Response viewer (formatted JSON).
  - Execution history (last N runs, stored locally or in `src/app/data.json`).
- Wire real fetches against the deployed endpoint URL.

### 5. Robustness
- Validate payloads defensively — do not crash on missing optional fields.
- `sandbox_run_command curl -s "<endpoint_url>?mode=test"` with a simulated payload before declaring the step complete.
- Confirm no DB row was mutated in test mode.

### 6. Delivery
`requirement_status action="create"` must include:
- `endpoint_url`: the backend URL, validated with `?mode=test`.
- `preview_url`: the runner Vitrina URL (permanent Vercel deployment from branch push).
- `message`: client-facing summary per `makinari-fase-reporteado`.

The workspace archive is uploaded automatically on each `sandbox_push_checkpoint`.

## Tools

| Tool | When to use |
| --- | --- |
| `sandbox_write_file` | Create endpoint files, inject Vitrina `data.json`, update runner UI config. |
| `sandbox_run_command` | Install deps, run `npm run build`, curl the endpoint in test mode. |
| `sandbox_read_file` | Read existing runner UI / endpoint files before editing. |
| `sandbox_list_files` | Explore the Vitrina structure and confirm route layout. |
| `requirements` | Read contract (section 6.1). Flag missing details via `## Open Questions`. |
| `requirement_status` | Final delivery with endpoint_url + preview_url. |
| `instance_plan` | Report step status via `action="execute_step"`. |

## Artifacts

- **Produces**: endpoint files under `src/app/api/**` or `clients/{site_id}/{req_id}/**`, runner UI updates in Vitrina, final `requirement_status` with both URLs.
- **Consumes**: `requirement.instructions` sections 6.1, 6.3, 7. Runner UI template from `makinari-obj-vitrinas`. Backend conventions from `makinari-rol-backend`.

## Anti-patterns

- Shipping the endpoint without a runner UI. The client needs a way to call it.
- Letting `?mode=test` mutate data because "it's just test mode".
- Hardcoding the endpoint URL into the Vitrina. Use an env var or form input so mode/URL can change without a redeploy.
