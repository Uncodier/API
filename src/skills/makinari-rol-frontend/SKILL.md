---
name: makinari-rol-frontend
description: Frontend role for Next.js UI, component creation, and repository hygiene inside the Vercel Sandbox. Enforces the UI test-id contract declared in the requirement, real functionality over mock UI, and the visual + runtime quality gate.
types: ['develop', 'design']
---

# SKILL: makinari-rol-frontend

## Objective

Implement UI pages and components in Next.js (App Router) that satisfy the requirement's section 6.4 (UI test-id contract) and section 7 (Acceptance Criteria). Every route must build, render without errors at desktop and mobile viewports, and wire real interactions.

## Environment

- **Working directory**: `/vercel/sandbox`.
- **Routes**: live under `src/app/**` only. Never create a top-level `app/` — paths like `app/src/app/page.tsx` do not compile on Vercel in this repo.
- **Package root**: `package.json` must be at `/vercel/sandbox/package.json`. Nested project roots break Vercel.
- **File size**: keep each file under 500 lines (project rule). Split large pages into components under `src/components/**`.

## Execution Rules

### 1. Repository hygiene
- If `package.json` is missing at the root, initialize Next.js there. Do not create a nested project.
- Respect the base branch chosen by `makinari-obj-template-selection`. Do not `git checkout` a different branch once development has started.

### 2. Data-testid contract (mandatory when requirement defines one)
The requirement's section 6.4 lists `data-testid` attributes the frontend must expose. Treat this list as **immutable**:

- Add every declared test-id to the correct element.
- **Never rename or remove** a declared test-id. QA scenarios and the automated gate target them by name; renaming is a regression.
- If a needed element is missing from section 6.4, stop and add it via `requirements action="update"` with a `## Revisions` entry. Do NOT invent test-ids on your own.

```tsx
// Good
<button data-testid="cta-primary" onClick={handleSubmit}>Start now</button>

// Bad — invented test-id not in the requirement
<button data-testid="cta-main-btn" onClick={handleSubmit}>Start now</button>
```

### 3. Real functionality, not demo UI
When the requirement says "functionalize" or "wire", do NOT ship:
- Buttons without handlers.
- Lorem ipsum or placeholder text.
- Hardcoded demo data that will ship to production.

Instead:
- Connect to real backends (Supabase / project API) if available.
- Implement `onClick`, `onSubmit`, loading states, and error states.
- Provide realistic empty states that match the requirement's copy/tone.

### 4. Shift-left build
Before reporting completion:
1. `sandbox_run_command npm run build`.
2. Fix every TypeScript, ESLint, and import error. Clean build is the floor, not the ceiling.
3. Verify there are no hydration warnings or `window is not defined` at runtime.

### 5. Visual + runtime quality gate (mandatory)
After the build passes, the platform runs an automated gate that probes your step in the sandbox. A green build is NOT enough — you are blocked unless:

- Every changed or added route renders without server errors or 4xx/5xx (runtime probe).
- The browser console shows no errors, no uncaught exceptions, no failed network requests.
- Screenshots at **1280x800** and **375x812** render a full page (not a blank shell, not a crashed SPA).
- A vision-model critic reviews each screenshot. `critical` or `high` severity defects block the gate.

To clear the gate, your UI must:
- Provide real content and realistic empty states — no Lorem Ipsum.
- Establish a clear visual hierarchy with one primary CTA above the fold at 1280 width.
- Maintain legible contrast and typography (body >=16px, line-height >=1.4).
- Keep mobile (375x812) free of horizontal scroll and overlapping elements.
- Wire real event handlers with loading and error states.
- Prefer semantic HTML (`<header>`, `<main>`, `<section>`, `<button>`).
- Add every `data-testid` listed in section 6.4 of the requirement.

### 6. Pre-completion checklist
Copy/paste this and verify every box before marking the step completed:

```
- [ ] `npm run build` passes
- [ ] All `data-testid`s from requirement section 6.4 are present
- [ ] No console errors at 1280x800 and 375x812
- [ ] Primary CTA visible above the fold at 1280 width
- [ ] All interactive elements have accessible names
- [ ] Real event handlers wired (no empty onClicks)
- [ ] No placeholder / lorem ipsum copy
```

### 7. Git and delivery
- The system auto-commits and pushes. Do NOT run `git commit` or `git push` manually.
- The permanent preview URL is extracted from the GitHub Deployments API after push. Do NOT guess URLs like `https://<project>-git-<branch>-<team>.vercel.app`.

### 8. Plan reporting
- Use `instance_plan` with `action="execute_step"`:
  - `step_status="completed"` + `step_output` summarizing routes changed and test-ids added.
  - Reference the `step_id` exactly as defined (e.g. `"step_3"`).

## Tools

| Tool | When to use |
| --- | --- |
| `sandbox_run_command` | `npm run build`, smoke curls, read-only git. |
| `sandbox_write_file` | Write page/component files under `src/app/**` and `src/components/**`. |
| `sandbox_read_file` | Read existing routes/components before editing. |
| `sandbox_list_files` | Explore the tree to avoid duplicate routes. |
| `requirements` | Read section 6.4/6.5/7 of the contract; escalate via `## Open Questions` if a required test-id is missing. |
| `instance_plan` | Report step status via `action="execute_step"`. |

## Artifacts

- **Produces**: page / component files under `src/app/**` and `src/components/**`. Exposes the `data-testid` set declared in the requirement.
- **Consumes**: `requirement.instructions` sections 6.4 (test-ids), 6.5 (seed scenarios hint), 7 (Acceptance Criteria).

## Anti-patterns

- Renaming a declared `data-testid` to "cleaner" naming. That breaks every QA scenario and the gate.
- Shipping a demo with empty buttons under the cover of "wireframe".
- Creating a second Next.js project under a nested folder.
- Catching and silencing hydration errors instead of fixing them.
