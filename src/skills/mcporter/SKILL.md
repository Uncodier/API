---
name: mcporter
description: Legacy reference. The mcporter CLI has been replaced by assistant tools in the Vercel Sandbox environment. Use the requirements, requirement_status, instance_plan, and sandbox tools directly instead.
types: []
---

# mcporter (Legacy)

The `mcporter` CLI is no longer used in the Vercel Sandbox environment.

## Migration Guide

| Old (mcporter) | New (Assistant Tools) |
|---|---|
| `mcporter call makinari.requirements action="list"` | Use `requirements` tool with `action="list"` |
| `mcporter call makinari.requirement_status action="create"` | Use `requirement_status` tool with `action="create"` |
| `mcporter call makinari.instance_plan action="create"` | Use `instance_plan` tool with `action="create"` |
| `mcporter call makinari.instance_plan action="execute_step"` | Use `instance_plan` tool with `action="execute_step"` |
| `mcporter call makinari.site_settings` | Use the site settings or memories tools |
| `mcporter call makinari.content` | Use the `content` tool |

All interactions with the Makinari platform now happen through the assistant's built-in tools. No CLI or MCP configuration is needed.
