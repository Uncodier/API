---
name: mcporter
description: Legacy reference. The `mcporter` CLI has been replaced by assistant tools in the Vercel Sandbox environment. Use the `requirements`, `requirement_status`, `instance_plan`, and `sandbox_*` tools directly instead.
types: []
---

# SKILL: mcporter (legacy)

## Objective

Document the migration from the deprecated `mcporter` CLI to the assistant's built-in tools. If an older plan or requirement references `mcporter`, use this mapping to translate to the current tooling.

## Migration Guide

| Old (`mcporter`) | New (assistant tools) |
| --- | --- |
| `mcporter call makinari.requirements action="list"` | `requirements` tool with `action="list"` |
| `mcporter call makinari.requirement_status action="create"` | `requirement_status` tool with `action="create"` and `stage` |
| `mcporter call makinari.instance_plan action="create"` | `instance_plan` tool with `action="create"` |
| `mcporter call makinari.instance_plan action="execute_step"` | `instance_plan` tool with `action="execute_step"` |
| `mcporter call makinari.site_settings` | Site settings tool or `memories` |
| `mcporter call makinari.content` | `content` tool |

All interactions with the Makinari platform now happen through the assistant's native tools. No CLI or MCP configuration is required.

## Tools

| Tool | When to use |
| --- | --- |
| `requirements` | Replacement for `mcporter call makinari.requirements`. |
| `requirement_status` | Replacement for `mcporter call makinari.requirement_status`. |
| `instance_plan` | Replacement for `mcporter call makinari.instance_plan`. |
| `content` | Replacement for `mcporter call makinari.content`. |
| `memories` | Replacement for site settings / history queries. |

## Artifacts

- **Produces**: none. This skill is reference-only.
- **Consumes**: nothing. It is consulted when translating legacy instructions.
