---
name: makinari-fase-reporteado
description: Reporting phase. Register progress, create requirement_status entries, and close the execution cycle.
types: ['develop', 'automation', 'content', 'design', 'task', 'integration']
---

# SKILL: makinari-fase-reporteado

## Objective
"Close the cycle and deliver." Register progress and finalize the requirement.

## Execution Rules

### 1. Git (Handled by System)
- The system automatically commits and pushes after your work is done. You do NOT need to run git commands.
- The permanent preview URL is obtained from the GitHub Deployments API after push.

### 2. Report Progress via instance_plan
- Use the `instance_plan` tool with `action="execute_step"` to mark your step as completed:
  - `step_id`: The exact step ID from the plan (e.g., `"step_1"`).
  - `step_status`: `"completed"`.
  - `step_output`: A brief summary of what was done.

### 3. Create Final Requirement Status
- Use the `requirement_status` tool with `action="create"`:
  - `status`: `"done"` or `"in-progress"` depending on whether more work is needed.
  - `preview_url`: The permanent deployment URL (provided by the system after push). If not yet available, leave empty and the system will fill it.
  - `endpoint_url`: For automations, the URL of the deployed endpoint.
  - `message`: Summary of the deliverable and any notes for the client.

### 4. Archive Source Code
- Source archive upload is performed automatically when calling `sandbox_push_checkpoint` (and after `sandbox_restore_checkpoint` when restoring).
- This creates a permanent archive of the deliverable.

### 5. Update Requirement
- If the work is fully complete, use `requirements action="update" status="done"`.
- If more cycles are needed, keep it as `"in-progress"`.
