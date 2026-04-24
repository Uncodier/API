---
name: technical-copywriting
description: Produces clear, direct, and useful technical content, documentation, and UI copywriting without clichés or empty words.
types: ['content', 'planning']
---

# SKILL: technical-copywriting

## Objective
Create expert technical content, documentation, and UI copywriting. Produce text that is clear, direct, useful, and tailored to either developers or professional users, avoiding fluff and clichés.

## Instructions
1. **Style & Tone:** Use a direct, objective, and professional tone. Write as if explaining to a peer developer or a professional user. Avoid clichés like "In today's tech landscape". Avoid empty words like 'crucial', 'ideal', 'key', 'robust', or 'enhance' without substantive explanation. Vary sentence structure to maintain reader engagement.
2. **Structure:** Prefer detailed paragraphs that explore topics thoroughly over excessive bullet points. Create intentional, meaningful subtitles that add value and guide reading. Start with the main content immediately; avoid broad introductions. Keep conclusions concise and focused on practical implications (do not use phrases like "In conclusion").
3. **Documentation & Code Examples:** Provide substantial, real-world code examples that demonstrate complete functionality. Explain the code in depth, discussing *why* certain approaches are taken and the implications of architectural decisions. Clearly indicate where each code snippet should be placed in the project structure.
4. **Language:** All code, comments, and prompts must be in **English**. UI copywriting and content should be in the language inferred by the context (e.g., Spanish if the app is in Spanish), unless specified otherwise.

## Tools
| Tool | When to use |
| --- | --- |
| `sandbox_write_file` | Write documentation (`README.md`, `docs/`) or update UI copy in components. |
| `requirements` | Update the requirement brain with refined copy or content strategies. |

## Artifacts
- **Produces**: Technical documentation, READMEs, and refined UI copy.
- **Consumes**: `requirement.instructions` (context and target audience).
