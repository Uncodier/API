---
name: automation-runner
description: Guide for running arbitrary code automations in the Vercel Sandbox.
types: ['automation']
---

# Automation Runner

When executing an `automation` requirement:
1. Read the requirement instructions carefully.
2. Use `sandbox_write_file` to create the automation script (e.g. Node.js or Python).
3. Use `sandbox_run_command` to execute the script and verify the output.
4. If there's an error, debug the script.
5. Report the result back via `requirement_status` with any endpoint_url if applicable.
