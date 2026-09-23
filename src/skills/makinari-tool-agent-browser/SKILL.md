---
name: makinari-tool-agent-browser
description: Browser automation and navigation skill using the agent-browser CLI. Enables the Vercel Sandbox agent to deterministically interact with UIs, take snapshots, find elements, and perform E2E actions.
types: ['automation', 'task', 'integration']
---

# SKILL: makinari-tool-agent-browser

## Objective

This skill empowers the agent in the Vercel Sandbox with the ability to use the `agent-browser` web automation CLI (https://github.com/vercel-labs/agent-browser).
It is intended for navigating URLs, exploring the DOM, taking visual screenshots, and executing deterministic browser interactions using semantic references. This is perfect for functional testing, validation, and navigating deployed preview apps or local dev environments without needing to write complex Playwright or Puppeteer scripts.

## Environment

- **Sandbox**: Vercel Sandbox.
- The runner provisions and validates `agent-browser` before your turn starts.
- Use the direct `sandbox_browser` tool. Do not install `agent-browser`, Chrome, Playwright, or system packages during a workflow step.
- Browser steps must declare `requires_browser: true`.
- Before using credentials, declare `browser_allowed_domains` for the trusted destination (for example, both `example.com` and `*.example.com` when needed).
- Declare only the required environment-variable names in `browser_secret_names`; undeclared variables are unavailable.
- Credential values are never placed in `process.env`. Use `value_env` with the variable name; the tool resolves it only on an allowed current origin. Never read, print, or return the secret value.

## Instructions

The `agent-browser` CLI uses a "Snapshots and Refs" architecture designed specifically for deterministic AI interactions, reducing the need to guess CSS selectors.

1. **Launch & Navigate:**
   Call `sandbox_browser` with `action="open"` and the target URL.
   - This starts a headless browser daemon in the background. It stays alive between commands, making subsequent calls extremely fast.
   
2. **Get Interactive State (Snapshot):**
   Call `sandbox_browser` with `action="snapshot"` and `interactive=true`.
   - `-i` filters the accessibility tree to output ONLY interactive elements (buttons, links, inputs).
   - `--json` formats the output so the agent can parse it reliably.
   - The output provides elements mapped to short references (Refs) like `@e1`, `@e2`.

3. **Interact using Refs:**
   Target actions using the precise Refs returned from the snapshot:
   - Click: `sandbox_browser({ action: "click", ref: "@e1" })`
   - Fill input: `sandbox_browser({ action: "fill", ref: "@e2", value: "test_input_value" })`
   - Fill a credential: `sandbox_browser({ action: "fill", ref: "@e2", value_env: "SERVICE_USERNAME" })`
   - Extract text: `sandbox_browser({ action: "get_text", ref: "@e3" })`

4. **Iterate (Re-snapshot):**
   Anytime the page mutates, navigates, or loads new content, call `sandbox_browser` with `action="snapshot"` again to receive newly updated refs.

5. **Wait for conditions:**
   Call `sandbox_browser` with `action="wait"` and either `load="networkidle"` or an element `ref`.

## Tools

| Tool | When to use |
| --- | --- |
| `sandbox_browser` | Navigate, inspect, and interact with web pages through the persistent browser session. |

## Artifacts

- **Produces**: Visual screenshots (e.g., `test.png`) or temporary DOM snapshots if requested.
- **Consumes**: The live URL (preview or localhost) of the application being tested.

## Anti-patterns

- Relying blindly on brittle CSS selectors. Instead, rely on `agent-browser snapshot -i` to discover existing elements and use the deterministic `@eX` Refs.
- Settling for HTTP 200 checks in QA. To truly validate a UI, navigate it with the CLI, submit forms, and evaluate the resulting DOM or success messages.
- Restarting the session for every command. The daemon persists to accelerate your workflow. Run actions sequentially, then call `sandbox_browser` with `action="close"` when finished.
- Forgetting to clean up artifacts. If you took screenshots (`test.png`) or generated temp data to validate the UI, delete them once the verification is finished to comply with the Sandbox Cleanup rule.
