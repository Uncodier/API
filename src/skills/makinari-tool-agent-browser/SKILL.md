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
- You execute `agent-browser` commands via standard command execution tools in your environment (e.g., `sandbox_run_command`).
- If `agent-browser` is not available, install it globally using `npm install -g agent-browser` and initialize it by running `agent-browser install` (which downloads the required Chrome browser binary).

## Instructions

The `agent-browser` CLI uses a "Snapshots and Refs" architecture designed specifically for deterministic AI interactions, reducing the need to guess CSS selectors.

1. **Launch & Navigate:**
   Use `agent-browser open <url>`.
   - This starts a headless browser daemon in the background. It stays alive between commands, making subsequent calls extremely fast.
   
2. **Get Interactive State (Snapshot):**
   Use `agent-browser snapshot -i --json`.
   - `-i` filters the accessibility tree to output ONLY interactive elements (buttons, links, inputs).
   - `--json` formats the output so the agent can parse it reliably.
   - The output provides elements mapped to short references (Refs) like `@e1`, `@e2`.

3. **Interact using Refs:**
   Target actions using the precise Refs returned from the snapshot:
   - Click: `agent-browser click @e1`
   - Fill input: `agent-browser fill @e2 "test_input_value"`
   - Extract text: `agent-browser get text @e3`

4. **Iterate (Re-snapshot):**
   Anytime the page mutates, navigates, or loads new content, always run `agent-browser snapshot -i` again to receive the newly updated `@eX` Refs.

5. **Wait for conditions:**
   Use `agent-browser wait --load networkidle` to wait until network traffic is idle, or `agent-browser wait <selector/ref>` to wait for an element to become visible.

6. **Chain Commands:**
   In the sandbox, you can save latency by chaining operations together using `&&`. The background daemon will process them efficiently.
   ```bash
   agent-browser open https://example.com && agent-browser wait --load networkidle && agent-browser snapshot -i --json
   ```

## Tools

| Tool | When to use |
| --- | --- |
| `sandbox_run_command` | Execute the `agent-browser` CLI commands in the sandbox shell. |

## Artifacts

- **Produces**: Visual screenshots (e.g., `test.png`) or temporary DOM snapshots if requested.
- **Consumes**: The live URL (preview or localhost) of the application being tested.

## Anti-patterns

- Relying blindly on brittle CSS selectors. Instead, rely on `agent-browser snapshot -i` to discover existing elements and use the deterministic `@eX` Refs.
- Settling for HTTP 200 checks in QA. To truly validate a UI, navigate it with the CLI, submit forms, and evaluate the resulting DOM or success messages.
- Restarting the session for every command. The daemon persists to accelerate your workflow. Run your commands sequentially, and execute `agent-browser close` when the entire task is complete.
- Forgetting to clean up artifacts. If you took screenshots (`test.png`) or generated temp data to validate the UI, delete them once the verification is finished to comply with the Sandbox Cleanup rule.
