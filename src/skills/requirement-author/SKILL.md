---
name: requirement-author
description: Create, structure, and maintain requirement instructions. Ensures requirements include deep architectural guidelines, basic app practices, and granular progress checklists.
types: ['develop', 'automation', 'content', 'design', 'task', 'integration', 'planning']
---

# Requirement Author

This skill dictates how to write and maintain requirement instructions. The instructions field in a requirement acts as the persistent memory and architectural blueprint for the project.

## Core Rules

1. **Never write superficial requirements.** Do not just write "Make a clone of X". Translate high-level business requests into concrete technical and architectural requirements.
2. **Always include Basic App Practices.** Every modern app needs defined rules for:
   - **Routing & Layouts:** Public vs. private layouts, nested routing, protected routes.
   - **Authentication & Authorization:** Login/logout flows, token management.
   - **State Management & Data Fetching:** React Context, Zustand, SWR, or direct API calls.
   - **UI/UX & Styling:** Tailwind conventions, responsive design, accessibility.
   - **Error Handling & Edge Cases:** 404 pages, empty states, loading skeletons.
3. **Include a Checkbox-driven Progress Plan.** The instructions must contain a clear, granular `[ ]` checklist representing execution steps.
4. **Define the Baseline.** Document the current state of the repository before new changes are applied.

## Where Instructions Live

- **Primary:** The `instructions` field of the requirement in the database. Update it via the `requirements` tool with `action="update"`.
- **Optional Snapshot:** Generate a `REQUIREMENT.md` in the repo root using `sandbox_write_file` for reference.
- Both agents and users can read/edit the `instructions` field.

## Standard Structure

When generating or updating requirement instructions, use this structure:

```markdown
# Project: <Name>

## 1. Overview
Clear professional summary of the application.

## 2. Baseline (Current State)
What exists in the repository. Starting point.

## 3. Technical Guidelines
- **Layouts & Routing:** ...
- **Authentication:** ...
- **State & Data:** ...
- **UI/UX:** ...

## 4. Feature Requirements
Specific features for this cycle, broken down logically.

## 5. Execution Plan
### Phase 1: Setup
- [ ] Task 1
- [ ] Task 2
### Phase 2: Features
- [ ] Task 3
```

## When Updating Existing Instructions

1. Read the current instructions from the requirement.
2. Preserve completed checkboxes (`[x]`).
3. Append or refine technical guidelines if they are missing basic app practices.
4. Add new features and checklists for the current cycle.
