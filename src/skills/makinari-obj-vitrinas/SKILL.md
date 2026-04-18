---
name: makinari-obj-vitrinas
description: Objective skill for delivering frontends based on pre-built Vitrina templates. Clone the right branch, inject data, and deploy.
types: ['develop', 'content', 'design', 'automation', 'task']
---

# SKILL: makinari-obj-vitrinas

## Objective
Fast delivery of frontends using pre-built Vitrina templates. Do NOT initialize Next.js from scratch.

## Execution Rules

### 0. Prerequisite
- Prefer **`makinari-obj-template-selection`** as **plan step 1** so the correct Vitrina branch (or generic baseline) is chosen and recorded before this skill runs. If base is already set in `instructions` (`BASE: …`), skip re-selection and follow §1.

### 1. Branch Workflow
- The repo at `/vercel/sandbox` is already cloned.
- Checkout the appropriate Vitrina base branch using `sandbox_run_command` with git:
  ```
  git fetch origin <base_branch>
  git checkout -B feature/{req_id} origin/<base_branch>
  ```
- Edit the data JSON files to inject the requirement's content.
- The system handles commit and push after you finish.

### 2. Vitrina Types and Base Branches

| Requirement Type | Vitrina | Base Branch |
|---|---|---|
| Content (Strategy, Copy, Articles) | Text/Markdown Viewer | `feature/9be0a6a2-5567-41bf-ad06-cb4014f0faf2/424cc56d-510e-4bbf-a4e1-aa2e30700325` |
| Design / Media (Visual Assets) | Gallery Viewer | `feature/9be0a6a2-5567-41bf-ad06-cb4014f0faf2/512ceb6a-f133-4716-9a10-0d2a008c10ed` |
| Presentations (Pitch Decks, Slides) | Slide Viewer | `feature/ce1b2fec-3455-49a1-a35d-54671c00d00d` |
| PDF Documents | PDF Viewer | `feature/16ccdd2c-6636-4b38-a4fc-89ea2c9fe0cc` |
| Data / Analytics | Data Table Viewer | `feature/6e819746-5da2-4e3a-8192-0a592dff99cc` |
| Automations (Webhook Runners) | Automation Runner UI | `feature/c3dcbbab-585a-46e9-b320-19b149a24aa0` |

### 3. Data Injection
- Read the existing data file with `sandbox_read_file` (usually `src/app/data.json` or `src/data.json`).
- Replace demo data entirely with the real content from the requirement.
- Use `sandbox_write_file` to save the updated data file.

### 4. Quality
- The Vitrina must be interactive (pagination, filtering, etc. as applicable).
- Remove ALL demo/placeholder data. Only real content from the requirement should remain.

### 5. Delivery
- The preview URL is the permanent Vercel deployment URL from the branch push (automatic).
- Use `requirement_status` to report the `preview_url`.
- The workspace archive is uploaded on each `sandbox_push_checkpoint` (and after `sandbox_restore_checkpoint`).
