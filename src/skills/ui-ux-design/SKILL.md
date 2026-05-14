---
name: ui-ux-design
description: Applies Modern Elite Design (Linear/Stripe style), anti-generic constraints, accessibility (WCAG 2.1 AA), and responsive mobile-first layouts to user interfaces.
types: ['design', 'develop']
---

# SKILL: ui-ux-design

## Objective
Apply expert UI/UX design principles to prevent "generic, sterile, 2020-era corporate UI" when creating software. Enforce a "Modern Elite Design" aesthetic (inspired by Linear, Vercel, and Stripe) using strict texture constraints, animations, semantic accessibility (WCAG 2.1 AA), and modern component libraries (shadcn/ui, Magic UI, Aceternity UI).

## Instructions

### 1. Anti-Generic Design Constraints
- **NO Default Colors:** Never use default, flat Tailwind colors (e.g., `bg-blue-500`, flat hex codes). Use the designated design system tokens or CSS variables.
- **NO Flat Backgrounds:** Avoid sterile, hyper-corporate "SaaS-template" aesthetics. Instead, use subtle gradients, grid patterns, or dark-mode-first glow effects.
- **Bento Grid Layouts:** Prefer modular, bento-box style layouts (1x1, 2x1, 1x2, 2x2 cards) for dashboards and features.

### 2. Modern Elite Design System (Linear / Stripe Style)
- **Aesthetic:** Default to dark-mode-first with a hyper-polished, engineered feel. Light is treated as part of the interface (subtle glows).
- **Borders & Glassmorphism:** Use frosted glass borders, e.g., `border border-white/10` or `1px solid rgba(255,255,255,0.08)`.
- **Typography:** Use Inter Variable for primary text and Berkeley Mono (or similar monospace) for technical data. Large, tight headings (e.g., `tracking-tight`).
- **Color Palette (Dark Mode Base):**
  - Background: `bg-[#08090a]` or Tailwind `bg-zinc-950`
  - Main Text: `text-[#f7f8f8]` or Tailwind `text-zinc-50`
  - Muted Text: `text-[#8a8f98]` or Tailwind `text-zinc-400`

### 3. Motion & Micro-interactions
- **Engineered Animations:** Small, meaningful animations. Do not overuse bouncy effects.
- **Standard Transitions:** Use 150–200ms ease-out transitions for hover states (`transition-all duration-200 ease-in-out`).
- **Press Effects:** Use a subtle scale down for buttons on active state (e.g., `active:scale-95` or `scale(0.98)`).

### 4. Component Libraries
- **Application UI:** Strongly prefer **shadcn/ui** for accessible, clean, and consistent application components.
- **Marketing / Landing Pages:** Use **Magic UI** or **Aceternity UI** for high-polish marketing components (animated beams, glowing cards, neon gradients) to stand out.

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
