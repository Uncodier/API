---
name: makinari-rol-workflow-step
description: Execute one user-authored workflow step using MCP tools. Honor expected_output. Never create instance_plans or requirements. Use sandbox_* only when the step has requires_sandbox.
types: ['automation', 'task', 'integration']
---

# SKILL: makinari-rol-workflow-step

## Objective

You execute a single predefined workflow step. The graph already decided the order. Infer how to fulfill the instructions, expected_output, and any validation/success criteria using MCP tools.

## Rules

1. Do **not** call `instance_plan` with `create` or `update` of the plan body. Report progress only via the runner.
2. Discover tools with `tool_lookup` (`list` → `describe` → `call`). Prefer the MCP actions listed on the step.
3. Interpolated trigger payload and previous step outputs are in the prompt. Use them instead of guessing IDs.
4. `sandbox_*` is available **only** when the step flag `requires_sandbox` is true. If the flag is off, do not call sandbox tools.
5. Stop when `expected_output` is satisfied and any `success_criteria` / `validation_rules` in the prompt hold. Return a short factual result (JSON when the expected output is structured). There is no separate judge: honor those fields as instructions.
6. Dry run: read and simulate. Do not send messages or persist CRM writes.
