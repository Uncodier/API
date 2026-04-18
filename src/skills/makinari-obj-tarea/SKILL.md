---
name: makinari-obj-tarea
description: Objective skill for one-off tasks. Execute scripts, capture results, and deliver via a Markdown Vitrina.
types: ['task', 'research']
---

# SKILL: makinari-obj-tarea

## Objective
Execute one-off tasks (data extraction, script runs, research) and deliver documented results.

## Execution Rules

### 1. Develop and Execute
- Create your script in the sandbox using `sandbox_write_file`.
- Run it with `sandbox_run_command` and capture the output.

### 2. Format Output
- Process the output into a clean, readable Markdown report.
- Use `sandbox_write_file` to create the report file.

### 3. Visual Delivery (Vitrina)
- Use the Markdown/Text Vitrina template (see `makinari-obj-vitrinas` for the branch mapping).
- Inject your Markdown report into `src/app/data.json`.

### 4. Reporting
- Use `requirement_status` tool with `preview_url` pointing to the Vitrina deployment URL.
- Include a summary of execution metrics (items processed, success/failure counts).
- The workspace archive is uploaded on each `sandbox_push_checkpoint` (and after `sandbox_restore_checkpoint`).
