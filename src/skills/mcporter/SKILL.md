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
| `mcporter call makinari.quotations` | `quotations` tool |
| `mcporter call makinari.quotation_items` | `quotation_items` tool |
| `mcporter call makinari.entitlements` | `entitlements` tool |
| `mcporter call makinari.checkout` | `checkout` tool |
| `mcporter call makinari.catalog_commerce` | `catalog_commerce` tool |
| `mcporter call makinari.reservation_schedules` | `reservation_schedules` tool |
| `mcporter call makinari.reservations` | `reservations` tool |
| `mcporter call makinari.subscription_plan_items` | `subscription_plan_items` tool |
| `mcporter call makinari.subscriptions` | `subscriptions` tool |
| `mcporter call makinari.price_lists` | `price_lists` tool |
| `mcporter call makinari.pass_redeemable_items` | `pass_redeemable_items` tool |

All interactions with the Makinari platform now happen through the assistant's native tools. No CLI or MCP configuration is required.

## Tools

| Tool | When to use |
| --- | --- |
| `requirements` | Replacement for `mcporter call makinari.requirements`. |
| `requirement_status` | Replacement for `mcporter call makinari.requirement_status`. |
| `instance_plan` | Replacement for `mcporter call makinari.instance_plan`. |
| `content` | Replacement for `mcporter call makinari.content`. |
| `quotations` | Replacement for `mcporter call makinari.quotations`. |
| `checkout` | Replacement for `mcporter call makinari.checkout`. |
| `catalog_commerce` | Replacement for `mcporter call makinari.catalog_commerce`. |
| `reservation_schedules` | Replacement for `mcporter call makinari.reservation_schedules`. |
| `reservations` | Replacement for `mcporter call makinari.reservations`. |
| `entitlements` | Replacement for `mcporter call makinari.entitlements`. |
| `subscription_plan_items` | Replacement for `mcporter call makinari.subscription_plan_items`. |
| `subscriptions` | Replacement for `mcporter call makinari.subscriptions`. |
| `price_lists` | Replacement for `mcporter call makinari.price_lists`. |
| `pass_redeemable_items` | Replacement for `mcporter call makinari.pass_redeemable_items`. |
| `memories` | Replacement for site settings / history queries. |

## Artifacts

- **Produces**: none. This skill is reference-only.
- **Consumes**: nothing. It is consulted when translating legacy instructions.
