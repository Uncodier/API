---
name: ui-ux-design
description: Applies visual design principles, hierarchy, accessibility (WCAG 2.1 AA), and responsive mobile-first layouts to user interfaces.
types: ['design', 'develop']
---

# SKILL: ui-ux-design

## Objective
Apply expert UI/UX design principles to software development tasks. Ensure visual consistency, clear hierarchy, accessible markup (WCAG 2.1 AA), and responsive mobile-first layouts when creating or modifying user interfaces.

## Instructions
1. **Visual Design & Hierarchy:** Establish a clear visual hierarchy to guide user attention. Use typography effectively for readability and emphasis (use relative units like `rem` or `em`). Maintain sufficient contrast for legibility.
2. **Accessibility (A11y):** Follow WCAG guidelines. Use semantic HTML (`<nav>`, `<main>`, `<article>`, `<aside>`) to enhance screen reader compatibility. Provide alternative text (`alt`) for images. Ensure keyboard navigability for all interactive elements (visible `:focus` states). Touch targets must be at least 44x44 pixels.
3. **Responsive & Mobile-First:** Design for mobile devices first, then scale up using media queries. Use relative units (`%`, `vw`, `vh`) and flexible layouts like CSS Grid and Flexbox.
4. **Consistency & Performance:** Maintain visual consistency using the project's design system (e.g., Tailwind CSS). Provide clear feedback for user actions (loading indicators, clear error messages). Optimize images and assets to minimize load times.

## Tools
| Tool | When to use |
| --- | --- |
| `sandbox_read_file` | Read existing UI components to understand the current design system. |
| `sandbox_write_file` | Create or update UI components with accessible and responsive markup. |

## Artifacts
- **Produces**: Accessible and responsive UI components (React/Next.js files).
- **Consumes**: `requirement.instructions` (design specifications and acceptance criteria).
