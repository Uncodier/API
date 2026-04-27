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
- **Contract Adequation:** If a needed element is missing from section 6.4 (e.g., a loading spinner, an error message, a clear button), do NOT stop or escalate. Create it, assign it a logical `data-testid`, and report it in your `step_output` using the `[CONTRACT ADEQUATION]` flag. See `makinari-contract-adequation` for details.

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
- Mocked API responses or fake databases in the frontend.
- Fake authentication states (e.g., `const isLoggedIn = true;`).

Instead:
- Connect to real backends (Supabase / project API) if available.
- CRITICAL: For transactional features (forms, bookings, creation, updates), you MUST implement the full end-to-end flow. Do NOT mock the data in the frontend. If the backend API doesn't exist, **apply Contract Adequation**: assume the logical endpoint path, wire the form to it, and report the assumed endpoint in your `step_output` with the `[CONTRACT ADEQUATION]` flag so the Backend agent builds it next.
- CRITICAL: For authentication and user management (login, signup, roles, protected routes), you MUST implement real authentication (e.g., Supabase Auth, NextAuth, or custom JWT) and enforce it in the frontend.
- Implement `onClick`, `onSubmit`, loading states, and error states.
- Provide realistic empty states that match the requirement's copy/tone.

### 3.1 Internal taxonomy is INVISIBLE to the user (gate-blocking)
The orchestrator state — backlog item ids, requirement ids, scope levels, phase ids, tier flags, file names like `requirement.spec.md` / `progress.md` / `feature_list.json` / `evidence/` — MUST NEVER appear in rendered HTML. The runtime probe scans every page body and the gate hard-rejects the step (failure category `copy`) when any of these surface in the user-facing copy:

- UUIDs (`ac83a5a9-4eed-42a3-a285-e92ae17ba44e`).
- Tokens: `item_id`, `requirement_id`, `scope_level`, `phase_id`, `backlog item`, `feature_list`, `spec.md`, `requirement.spec`, `progress.md`, `evidence/`, `tier=core`, `tier=ornamental`.
- Meta-prose narrating which backlog item produced the page: `Resumen del backlog`, `El item <id>`, `queda resumido`, `landing visible y construible en '/'`, `Backlog summary`, etc.
- Generic placeholders: `lorem ipsum`, `placeholder copy`, `coming soon (placeholder)`, `TODO:`, `TBD:`.

The recurring failure mode is interpreting a backlog item title (e.g. *"Resume the backlog in a landing visible and buildable at /"*) as user copy. That is wrong: the backlog title is an instruction to YOU; the page must showcase the actual product (audience, value prop, real CTAs).

```tsx
// Bad — leaks orchestrator state into the rendered home
<section>
  <h2>Resumen del backlog</h2>
  <p>El item ac83a5a9-4eed-42a3-a285-e92ae17ba44e queda resumido en una landing visible y construible en "/".</p>
</section>

// Good — user-facing product copy from the requirement spec
<section>
  <h2>Reserva tu espacio en minutos</h2>
  <p>Encuentra coworking flexible cerca de ti, reserva al instante y únete a la comunidad habitUall.</p>
</section>
```

If the backlog item title is the only context you have, derive copy from `requirement.spec.md` sections 1 (vision), 2 (audience) and 4 (value prop). Never paraphrase the item title and never print the item id.

### 4. The Boy Scout Rule (Refactor before you feature)
When you open an existing file to add a new feature, you MUST evaluate its current health before adding your code:
1. If the file is over 500 lines, you MUST extract parts of it into smaller components/modules BEFORE adding your new logic.
2. If the file contains mock data or fake authentication, you MUST replace it with real integrations if possible.
3. If the code is messy or lacks ES Modules structure, clean it up.
Always leave the code cleaner than you found it. Do this refactoring as part of your current step.

### 5. Shift-left build
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

### 9. Component kit contract (Phase 6)

The app/site gate runs `uses_component_kit` over the diff. It rejects raw
`<button>`, `<input>`, `<select>`, `<textarea>`, `<dialog>` and
`<form>` *whenever* an equivalent `@/components/ui/*` is present in the
repo. Required pattern:

```tsx
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
// ...
<Button variant="outline" onClick={...}>Save</Button>
```

If `@/components/ui/<name>` does NOT exist, run `npx shadcn add <name>`
(or copy from a sibling app baseline) BEFORE writing the page. Do not
inline raw HTML primitives "for now" — the gate will catch it.

Allowed exceptions (no rejection): semantic landmarks (`<header>`,
`<main>`, `<section>`, `<footer>`, `<nav>`), `<a>` for external links,
and `<img>` only when wrapping a `next/image` is impossible. Document the
exception in `progress.md`.

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
