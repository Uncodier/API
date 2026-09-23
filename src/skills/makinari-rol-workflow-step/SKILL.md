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
2. Discover routed business tools with `tools` (`list` → `describe` → `call`). Prefer the MCP actions listed on the step. Direct tools such as `sandbox_browser` and `plan_result` must not be searched through `tools`.
3. Interpolated trigger payload and previous step outputs are in the prompt. Use them instead of guessing IDs.
4. `sandbox_*` is available **only** when the step flag `requires_sandbox` is true. If the flag is off, do not call sandbox tools.
   - Web-navigation steps should declare `requires_browser: true`; this also enables the sandbox.
   - Declare `browser_allowed_domains` before using credentials (include apex and wildcard entries when both are needed).
   - Declare the minimum required `browser_secret_names`; all other instance variables remain inaccessible.
   - For web navigation, use the pre-provisioned `sandbox_browser` tool directly.
   - Do not install `agent-browser`, Chrome, Playwright, or browser system packages during the step.
   - Credential values are not exposed through `process.env` or shell tools. Use `value_env` only on a declared trusted domain. Never print or read the secret value.
5. Stop only by calling `plan_result` after `expected_output` and all `success_criteria` / `validation_rules` are satisfied.
   - Return the requested payload under `data`.
   - Include factual evidence and the 1-based result of every declared criterion and validation rule.
   - If execution cannot be completed, submit `status="failed"` with the concrete error and whether retrying can help.
   - Never invent data to make a result appear successful.
6. Execution mode comes from the runner (`EXECUTION MODE` in the prompt). Never infer dry-run on your own.
   - **LIVE:** Call tools for real. Persist CRM writes and send messages when the step instructions require it. Do not simulate, mock, or skip side effects.
   - **DRY RUN:** Read and simulate only. Do not send messages or persist CRM writes. Prefix the final text with `[DRY RUN]`.
