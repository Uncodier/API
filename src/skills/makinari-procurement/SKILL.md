---
name: makinari-procurement
description: Administer procurement, compras, solicitudes de compra, requisiciones, licitación/licitacion/licitaciones, concursos, invitación/invitacion/invitaciones a proveedores, cotizaciones de proveedores, adjudicación/adjudicacion/adjudicaciones, órdenes/ordenes de compra y recepción/recepcion. Requisitions, tenders, invitations, supplier proposals, awards, purchase orders and acceptance through policy-controlled workflows. Not legacy accounts payable or customer sales.
types: ['automation', 'task', 'integration']
---

# Procurement workflows

## Authority and discovery

Load this skill with `skill_lookup` using `action="get"` and
`skill_name="makinari-procurement"`, or search with `query="procurement tenders awards"`.
Then discover the domain tools with `tools` `action="search"`
`query="procurement"`, describe the relevant tool, and call its documented action.
Skill discovery does not grant permission to execute tools; their screen and
database authorization still apply.

Use `tools` list/search/describe to discover the six `procurement_*` tools. The
host binds workspace and actor. Never pass `site_id`, `user_id`, approval plans,
roles or arbitrary RPC names. Tools follow the corresponding screen's access
permissions for discovery and execution, like the other tools. The canonical
database operations additionally require an active owner/admin without location
restrictions; access to a screen alone does not override that rule.
Human decisions additionally require the configured
approver's eligibility; never impersonate another approver or convert a suggestion
into their vote. Ask for the user's decision before casting a consequential vote.

## Workflow

1. Read `procurement_policy` (`get`). A missing or blocking saved policy must be
   configured in the procurement UI; these tools cannot weaken it.
2. `procurement_requests`: `save` a full draft with `expected_revision=0` and no
   `id`; `get` before editing with current revision. `submit` requests approvals.
   `decide` uses a stage ID, current revision and reason. `revalidate` creates a
   new revision for correction; historical approvals are never copied as consent.
3. `procurement_tenders`: `save` with `expected_version=0` and no `id` creates a
   draft. Link an eligible request, or use `request_id=null` for standalone sourcing.
   Select `open`, `invitation_only` or `approved_suppliers` participation explicitly.
   `participant` records `invited` or `withdrawn` supplier eligibility using the
   current tender version. It does **not** send email or create an invitation link.
4. `publish` requests policy-controlled publication. A `pending` approval is not
   publication. Resolve the required approval with `procurement_approvals`; read
   the tender/publications to confirm release. `portal` controls portal visibility;
   it does not publish drafts. Use `transition` for `close`, `cancel` or `delete`
   subject to canonical state restrictions, never overwrite status.
5. `procurement_quotations`: `options` discovers eligible suppliers and published
   requirements; `record` imports a **buyer-recorded** proposal, not a supplier's
   authenticated submission. Supply every required line and a stable UUID
   `idempotency_key`. `list`/`get` respect sealed opening rules. Do not use legacy
   sales quotation tools to inspect or edit procurement proposals.
6. `procurement_approvals` `create` with `event=award` targets the chosen quotation
   and its `procurement_revision`. Record only explicitly authorized decisions.
   Read the approval afterward: creating a pending approval is not adjudication.
   The module supports a whole-proposal award, not split awards.
7. `create` with `event=order` targets the award ID at version 1. The server checks
   current/inherited policy, catalog mapping, taxes, supplier eligibility and
   required approvals. Use `procurement_orders` `list` to confirm materialization.
8. `procurement_orders` `receive` records partial/full **non-stock acceptance**.
   It does not increase inventory, post journal entries, pay suppliers or settle AP.

## Safe retries and units

- Money is integer **minor units**, unlike decimal amounts in legacy `purchases`.
- Never invent versions, suppliers, publication IDs, stages or item IDs.
- On a conflict, reread and reevaluate. Do not automatically resubmit a stale edit.
- MCP pending event approvals must retain their evaluated context. Category or
  effective-rule changes invalidate it even when the target revision is unchanged.
  Historical/UI approvals without an MCP snapshot must be resolved in the UI;
  repeating `create` with the same version/policy does not replace an old gate.
- For quotation/receipt retry, reuse the identical key and payload. A new key is
  a new operation, not a retry. Other creates are not generally idempotent: after
  an uncertain response, inspect existing records before creating another.
- Request/tender/approval lists use bounded `limit`/`offset`. Quotation/order lists
  expose the canonical latest-100 window; do not claim they are complete exports.
- Business-calendar timing, sequential relative deadlines and autonomous AI votes
  remain blocked where no trusted executor is integrated. Explain the blocker.
- Supplier onboarding, policy edits, supplier-side submissions and evidence upload
  remain in the existing UI. These tools do not invent bypasses for missing evidence.

## Related domains

`purchases`/`purchase_items` are legacy vendor bills and AP, not governed procurement
orders. `transactions` is for expenses/payroll. `quotations`/`quotation_items` are
customer sales quotations. Never substitute these for procurement transitions.