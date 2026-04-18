---
name: makinari-fase-investigacion
description: Investigation phase. Understand the context before writing code or content. Read existing code, site settings, and memories.
types: ['develop', 'automation', 'content', 'design', 'task', 'integration']
---

# SKILL: makinari-fase-investigacion

## Objective
"Know where you stand." This is Phase 0. Before writing code or text, you must understand the context.

## Execution Rules

### 1. Extract Context
- Use the `memories` tool to search for history associated with the site or requirement.
- Use `sandbox_list_files` and `sandbox_read_file` to explore the repository structure and existing code.
- If the requirement references a client site, read site settings or content from the platform tools.

### 2. Explore the Repository
BEFORE editing any files:
- Analyze structure: `sandbox_list_files` on key directories.
- Read the current code: `sandbox_read_file` on relevant files. Build on previous progress, do NOT overwrite blindly.
- Check history: `sandbox_run_command` with `git log --oneline -20`.
- Verify dependencies: `sandbox_read_file` on `package.json` and check import paths.

### 3. Zero Hallucinations
- NEVER guess. If the requirement references a client site, inspect it or extract info from the database first.
- Do NOT use fabricated data or assume file structures that you have not verified.

### 4. Output
- Summarize your findings: what exists, what is missing, and what needs to change.
- This summary feeds into the planning phase.
