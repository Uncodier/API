---
name: ui-ux-design
description: Applies Brand Guidelines (Design Tokens), accessibility (WCAG 2.1 AA), and responsive mobile-first layouts to user interfaces, avoiding generic aesthetics.
types: ['design', 'develop']
---

# SKILL: ui-ux-design

## Objective
Apply expert UI/UX design principles to prevent "generic, sterile, 2020-era corporate UI". Enforce the brand's unique identity by strictly following the **Brand Guidelines and Design System Tokens** provided by the orchestrator (or found in `memories` / context). Use semantic accessibility (WCAG 2.1 AA), and modern component libraries (shadcn/ui, Magic UI, Aceternity UI).

## Instructions

### 1. Brand Guidelines & Design Tokens First
- **NO Default Colors:** Never use default, flat Tailwind colors (e.g., `bg-blue-500`, flat hex codes) unless they exactly match the brand. Use the designated design system tokens (CSS variables) derived from the Brand Guidelines.
- **Extract the Tokens:** Read the `instructions` provided by the Orchestrator. Look for explicit requirements regarding:
  - **Color Tokens:** Primary, Secondary, Accent, Surface.
  - **Typography:** Brand-specific font families (e.g., headings vs body).
  - **Spacing & Border Radius:** The required scale (e.g., sharp corners vs rounded).
- **Configuration over Hardcoding:** When implementing designs, configure these tokens in `globals.css` or `tailwind.config.ts` so they can be consumed via standard utility classes (e.g., `bg-primary`, `rounded-brand`).

### 2. Layout & Aesthetic Guidelines (The "Empty State Killer" Rule)
- **Prohibit Empty Backgrounds:** NEVER use purely solid color backgrounds (`bg-black`, `bg-white`) for the Hero section or major structural blocks of a Marketing / Landing page. You MUST use a visual texture, such as a Grid Pattern, Dot Pattern, glowing gradients, or a subtle noise effect to prevent the site from looking flat.
- **Bento Grid Layouts:** Prefer modular, bento-box style layouts (1x1, 2x1, 1x2, 2x2 cards) for dashboards and features, rather than basic row/column grids.
- **Thematic Consistency:** Ensure the contrast mode (Light vs Dark) respects the brand's primary identity. Do not force "Dark Mode Stripe style" if the brand is light and airy.

### 3. Motion & Micro-interactions
- **Scroll Animations & Reveals:** For Landing pages, mandate the use of `framer-motion` for scroll reveals, fade-ins, and element staggering.
- **Engineered Animations:** Small, meaningful animations. Do not overuse bouncy effects.
- **Standard Transitions:** Use 150–200ms ease-out transitions for hover states (`transition-all duration-200 ease-in-out`).
- **Press Effects:** Use a subtle scale down for buttons on active state (e.g., `active:scale-95` or `scale(0.98)`).

### 4. Component Libraries & Media
- **Application UI:** Prefer **shadcn/ui** for accessible, clean, and consistent B2B/dashboard application components.
- **Marketing / Landing Pages (MANDATORY):** You MUST use **Magic UI** or **Aceternity UI** for high-polish marketing components (animated beams, glowing cards, bento grids, neon gradients) to stand out. Do not just "consider" it; it is a requirement to prevent flat corporate UI.
- **Dynamic Images:** Prefer the absolute Makinari endpoint `https://backend.makinari.com/api/public/image/prompt/[url_encoded_prompt]?width=800&height=600` (never a relative `/api/...` path on the app).

### 5. Accessibility (A11y) & Responsive
- **WCAG 2.1 AA:** Follow guidelines. Ensure sufficient contrast. Use semantic HTML (`<nav>`, `<main>`, `<article>`) and appropriate ARIA attributes.
- **Keyboard & Touch:** Ensure keyboard navigability (visible `:focus-visible` rings) and touch targets of at least 44x44 pixels.
- **Mobile-First:** Design for mobile devices first, scaling up with Tailwind's `md:`, `lg:` prefixes.

## Tools
| Tool | When to use |
| --- | --- |
| `sandbox_read_file` | Read existing UI components to understand the current design system. |
| `sandbox_write_file` | Create or update UI components with accessible, modern elite markup. |
| `sandbox_run_command` | Add shadcn/ui components (`npx shadcn-ui@latest add [component]`) or MagicUI components. |

## Artifacts
- **Produces**: High-polish, non-generic UI components (React/Next.js files with Tailwind CSS).
- **Consumes**: `requirement.instructions` (design specifications and acceptance criteria).
