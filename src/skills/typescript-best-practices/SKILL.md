---
name: typescript-best-practices
description: Enforces SOLID principles, strict typing, modularity, and code conventions for TypeScript and Node.js development.
types: ['develop']
---

# SKILL: typescript-best-practices

## Objective
Write clean, readable, and maintainable TypeScript code. Enforce strict typing, SOLID principles, and modular architecture while keeping file sizes manageable and avoiding premature optimization.

## Instructions
1. **Core Principles:** Write straightforward, maintainable code. Follow SOLID principles and appropriate design patterns. Avoid premature optimization: write clear code first, optimize later only if necessary.
2. **Strict Typing:** Use TypeScript for all code. Avoid using `any` or `unknown` unless absolutely necessary. Prefer `interface` over `type` for object shapes.
3. **File Structure & Size:** **Golden Rule:** Keep files under 500 lines. If a file exceeds this limit, refactor it into smaller modules to avoid overly large contexts. Structure files logically: main exports at the top, subcomponents/helpers, static content, and types/interfaces at the bottom.
4. **Naming Conventions:**
   - Classes: `PascalCase`
   - Variables, functions, methods: `camelCase`
   - Files, directories: `kebab-case`
   - Constants, environment variables: `UPPER_SNAKE_CASE`
   - Use descriptive names with auxiliary verbs (e.g., `isLoading`, `getUserData`, `hasError`).
5. **Functions & Control Flow:** Use arrow functions for simple operations. Use default parameters and object destructuring. **Early Returns:** Handle errors and edge cases at the beginning of functions using guard clauses. Place the "happy path" at the end. Avoid deep `if/else` nesting.
6. **Error Handling:** Implement proper error handling and clear logging. Consider modeling expected errors as return values instead of using `try/catch` for normal control flow. Throw user-friendly errors when appropriate.
7. **Language:** All code, comments, and prompts must be in **English**, unless specified otherwise or required by the context (e.g., UI text in another language).

## Tools
| Tool | When to use |
| --- | --- |
| `sandbox_read_file` | Read existing code to understand architecture and types. |
| `sandbox_write_file` | Write or refactor TypeScript code following best practices. |

## Artifacts
- **Produces**: Clean, strictly typed, and modular TypeScript code.
- **Consumes**: `requirement.instructions` (business logic and architectural guidelines).
