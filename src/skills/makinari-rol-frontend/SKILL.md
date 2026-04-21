---
name: makinari-rol-frontend
description: Frontend development skill for Next.js UI, component creation, and repository management inside the Vercel Sandbox.
types: ['develop', 'design']
---

# SKILL: makinari-rol-frontend

## Objective
Develop UI components, pages, and features using Next.js inside the Vercel Sandbox.

## Environment
- Working directory: `/vercel/sandbox`
- Tools: `sandbox_run_command`, `sandbox_write_file`, `sandbox_read_file`, `sandbox_list_files`

## Execution Rules

### 1. Repository Hygiene
- ALWAYS work inside `/vercel/sandbox`. Never create nested project directories.
- The `package.json` MUST be at the root (`/vercel/sandbox/package.json`). If it is nested, Vercel will fail.
- **App Router routes live only under `src/app/`** (e.g. `src/app/prd/page.tsx`). Do **not** create a top-level `app/` folder for pages — paths like `app/src/app/prd` are a common model mistake and **will not compile** on Vercel in this repo.
- If no `package.json` exists, initialize Next.js at the root.

### 2. Shift-Left Testing
- You are responsible for your own code quality.
- Before marking any step as completed, run `sandbox_run_command` with `npm run build` and fix all errors (TypeScript, linter, imports).
- Only when the build compiles clean can you report the step as done.

### 3. Real Functionality (Not Just UI)
- When asked to "functionalize" an app, do NOT just add empty buttons or mock data.
- Connect to real backends (Supabase/API) if available.
- Implement real event handlers (`onClick`, `onSubmit`), loading states, and error handling.
- Ensure navigation works and does not lead to 404s.

### 4. Code Quality
- Run `npm run build` via `sandbox_run_command` and resolve all TypeScript and linter errors.
- No hydration mismatches or "window is not defined" errors.
- Verify the code actually solves the original requirement.

### 4b. Visual & Runtime Quality Gate (mandatory)
After the build passes, an automated gate probes your step in the sandbox. A clean build is NOT enough — you will be blocked unless:
- Every changed/added route renders without server errors or 4xx/5xx (runtime probe).
- The browser console shows no errors, no uncaught exceptions, no failed network requests on the rendered pages.
- Screenshots at **1280×800** and **375×812** render a full page (not a blank shell, not a crashed SPA).
- A vision-model critic reviews each screenshot against a UI rubric (layout hierarchy, spacing consistency, contrast, empty-state handling, primary CTA above the fold, typography, accessibility). **Critical** or **high** severity defects block the gate.

Because of this, when you build UI you MUST:
- Provide real content (not lorem ipsum placeholders) and realistic empty states.
- Design a clear visual hierarchy: one obvious primary CTA above the fold at 1280 width.
- Maintain legible contrast and readable typography (≥16px body, ≥1.4 line-height).
- Ensure the mobile viewport (375×812) has no horizontal scroll and no overlapping elements.
- Wire real event handlers and loading/error states — a button that does nothing is a defect, not a feature.
- Prefer semantic HTML (`<header>`, `<main>`, `<section>`, `<button>`) and add `data-testid` attributes on primary CTAs, forms, and success/error states so QA scenarios can target them stably.

### 5. Git and Delivery
- The system auto-commits and pushes after you finish. You do NOT need to run git commands manually.
- The permanent preview URL is extracted from the GitHub Deployments API after push. Do NOT guess URLs.

### 6. Plan Step Reporting
- Use the `instance_plan` tool with `action="execute_step"` to report progress:
  - `step_status="completed"` with a brief `step_output` summary.
  - Include the step_id exactly as defined in the plan (e.g., `"step_1"`).
