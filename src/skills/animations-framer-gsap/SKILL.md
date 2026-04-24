---
name: animations-framer-gsap
description: Implements fluid animations using CSS, Framer Motion, or GSAP while optimizing performance and respecting accessibility preferences.
types: ['design', 'develop']
---

# SKILL: animations-framer-gsap

## Objective
Add fluid, purposeful animations and dynamic UI transitions using CSS, Framer Motion, or GSAP. Optimize for performance by avoiding reflows and respect user accessibility preferences for reduced motion.

## Instructions
1. **Performance & Fluidity:** Animate **only** properties that do not trigger browser reflow or repaint: `transform` (translate, scale, rotate) and `opacity`. Avoid animating `width`, `height`, `top`, `left`, `margin`, or `padding`. Use `will-change` sparingly and only for complex animations. Prefer CSS animations over JavaScript for simple effects (hover, focus, loaders).
2. **User Experience (UX):** Animations must have a purpose: guide attention, provide state feedback, or explain spatial relationships. Keep durations short (150ms - 300ms). Use natural easing functions (`ease-out` for entering, `ease-in` for exiting). Do not overuse animations to prevent visual fatigue.
3. **Accessibility:** **Always** respect user preferences for reduced motion. In CSS, use `@media (prefers-reduced-motion: reduce)`. In Framer Motion, use the `useReducedMotion` hook to adapt behavior.
4. **Specific Tools:**
   - **Framer Motion:** Use `layoutId` for shared layout animations. Use `AnimatePresence` to animate components when they unmount.
   - **GSAP:** Use `gsap.context()` in React to manage the lifecycle and prevent memory leaks. Use `ScrollTrigger` for scroll-based animations, ensuring layout refreshes when the DOM changes.

## Tools
| Tool | When to use |
| --- | --- |
| `sandbox_read_file` | Read existing components to determine where animations should be applied. |
| `sandbox_write_file` | Implement Framer Motion, GSAP, or CSS animations in the codebase. |

## Artifacts
- **Produces**: Animated UI components with optimized performance and accessibility fallbacks.
- **Consumes**: `requirement.instructions` (animation requirements and UX flow).
