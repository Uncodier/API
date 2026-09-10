# Skill Design & Architecture Best Practices

This document compiles the architectural principles and operational patterns derived from industry-leading coding agents (OpenHands/SWE-agent, Vercel v0, Claude). It acts as the source of truth for how Makinari's orchestrator and execution skills should behave.

## 1. Orchestration (Based on OpenHands & SWE-agent)

### Pattern 1: AgentContext & Strict Delegation
The orchestrator must act as the primary context collector. It does not execute UI code or solve the technical problem directly. 
- **The Loop:** It reads the repository state, pulls external knowledge (like **Brand Guidelines** via the `memories` tool), and creates an `AgentContext`.
- **The Delegation:** It injects this exact, synthesized context into the prompt of the sub-agent (e.g., via `instance_plan`). Sub-agents should not be guessing brand colors; the orchestrator provides them.

### Pattern 2: Strictly Sequential Self-Correction (No Parallel Cleanup)
Agents perform best when reasoning sequentially. 
- Do not rely on parallel background agents (e.g., a "maintenance orchestrator") to clean up tech debt or fix QA issues. 
- **Reflection:** If a downstream agent (QA or Validation) fails, the failure signal returns to the main orchestrator loop. The orchestrator must then schedule a new sequential step (Correction/Refactor) to fix the issue on the same branch before proceeding.

## 2. UI / UX Design (Based on Vercel v0 & Generative UI Patterns)

### Pattern 1: Explicit Design System Tokens
Avoid hardcoding generic "AI styles" (e.g., forcing dark mode, defaulting to `bg-blue-500` or sterile SaaS templates) into the agent's baseline skill.
- Design agents must be instructed to consume **Design System Tokens** injected by the orchestrator (or read from `.env` / `memories`).
- The contract must enforce specific:
  - **Typography:** Exact font family names.
  - **Color Tokens:** Brand-specific Primary, Surface, and Accent values.
  - **Spacing & Radius:** Scale parameters dictated by the brand.
- Generating a variant based on explicit tokens produces much stronger, brand-aligned output than generic style prompting.

## 3. Frontend Implementation (Based on Claude Frontend Engineer Workflows)

### Pattern 1: Mandatory Phase 0.5 (Style Guide Reading)
Before the frontend agent writes any React component, it must execute an initial phase:
- **Phase 0.5:** Inspect the repository's styling configuration (e.g., `tailwind.config.ts`, `globals.css`, or equivalent theme files). 
- If the required Brand Tokens are missing, the agent must update these configuration files first. This ensures utility classes (e.g., `bg-primary`) map correctly to the brand, preventing the agent from inventing hex codes inside the JSX.

### Pattern 2: The Boy Scout Rule (In-step Refactoring)
- Technical debt must be addressed immediately by the agent modifying the file. 
- If a file exceeds size limits (500 lines) or contains mocked data, the frontend agent must extract or clean it *before* adding the new feature within its current sequential step. There is no parallel safety net.

## Summary Checklist for Skill Updates
- [x] Orchestrator pulls Brand Guidelines (Context) and delegates them via `instance_plan`.
- [x] Orchestrator manages failures via sequential reflection, not parallel workers.
- [x] UI/UX Skill demands Design Tokens and drops rigid base styles.
- [x] Frontend Skill enforces "Phase 0.5" config reading and strict in-step refactoring.