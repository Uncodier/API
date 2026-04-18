---
name: makinari-fase-planeacion
description: Planning phase. Define execution steps, assign roles/skills, and create the instance_plan before development begins.
types: ['develop', 'automation', 'content', 'design', 'task', 'integration']
---

# SKILL: makinari-fase-planeacion

## Objective
"Map the path before walking." Define the logical steps of execution to prevent hallucinations, missing context, and wasted effort.

## Execution Rules

### 1. Use Platform Tools
- Read context from the investigation phase output.
- Use the `requirements` tool to read the full requirement details.
- Use the `instance_plan` tool with `action="list"` to check for existing plans before creating a new one.

### 2. Create Structured Plans
Use the `instance_plan` tool with `action="create"` and assign a `skill` to each step:

```json
{
  "action": "create",
  "title": "Plan: <requirement_title>",
  "steps": [
    {
      "id": "step_1", "order": 1,
      "title": "Development",
      "skill": "makinari-rol-frontend",
      "instructions": "Detailed instructions for the developer..."
    },
    {
      "id": "step_2", "order": 2,
      "title": "Validation",
      "skill": "makinari-fase-validacion",
      "instructions": "Run build, verify no errors..."
    },
    {
      "id": "step_3", "order": 3,
      "title": "Report",
      "skill": "makinari-fase-reporteado",
      "instructions": "Create requirement_status with results..."
    }
  ]
}
```

### 3. Hand-off Safety
- **Developer steps:** Must include instructions to build/test locally before completion.
- **DevOps steps:** Must verify the commit SHA exists on GitHub before deploying.
- **Orchestrator validation:** After all steps, verify the preview URL is live.

### 4. Update Requirement Instructions
- As you refine the plan, update the requirement's `instructions` field via `requirements action="update"`. This keeps the "brain" in sync with the latest plan.
- Optionally write a `REQUIREMENT.md` snapshot to the repo using `sandbox_write_file`.
