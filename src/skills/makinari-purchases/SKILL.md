---
name: makinari-purchases
description: Manage vendor bills, purchase orders (PO), and accounts payable line items. Use when recording supplier invoices, PO headers, purchase_items, or payments owed to vendors — not buyer checkout or customer sales.
types: ['automation', 'task', 'integration']
---

# Makinari Purchases (Vendor Bills / PO)

## Objective

Equip the agent to create and manage site-owned accounts payable: vendor bill headers (`purchases`) and their line items (`purchase_items`), including registering supplier payments.

## Instructions

1. **Do not confuse “purchase” domains**
   - **Vendor purchase (this skill):** money the site owes or paid to a supplier (`purchases` AP / PO).
   - **Buyer purchase (commerce):** a customer buying from us via `checkout` / entitlements `source_type=purchase`. Use `makinari-commerce` for that — never these tools.

2. **When to create `purchases` vs `purchase_items`**
   - Create **`purchases` first** for a new vendor bill / PO header: title, optional `vendor_company_id`, date, currency, location, notes. Status starts as `draft`.
   - Create **`purchase_items` after** you have a `purchase_id`. Add/change/remove lines only on an existing header. Never invent a headerless line.
   - Typical sequence: `purchases` `action="create"` → one or more `purchase_items` `action="create"` → optionally `purchases` `action="update"` (status `pending`/`completed`) or `action="register_payment"`.

3. **Header workflow (`purchases`)**
   - `create`: requires `title` and `site_id`. Defaults: `amount=0`, `amount_due=0`, `payments=[]`, `accounting_state=pending`, `stock_received=false`.
   - `list` / `get`: inspect bills; `get` returns nested `purchase_items` and vendor company.
   - `update`: patch title, vendor, status (`draft`|`pending`|`completed`|`cancelled`), currency, date, location, notes, `amount_due`.
   - `register_payment`: requires `id`, `amount`, `method`. Appends to `payments`, reduces `amount_due`, sets `status=completed` when due hits 0.
   - `delete`: removes the bill (items cascade via FK).

4. **Line workflow (`purchase_items`)**
   - `create`: requires `purchase_id` and either `name` or `catalog_item_id`. Hydrates name/`unit_cost` from `catalog_items` when missing. `subtotal = quantity * unit_cost`. Parent `amount` / `amount_due` recalculate automatically.
   - `list` / `update` / `delete`: manage lines; totals on the parent purchase stay in sync.

5. **Anti-patterns**
   - Do NOT use `checkout`, `sales`, or `sales_order` for supplier bills.
   - Do NOT use these tools to set up catalog products — use `catalog_commerce`.
   - Do NOT invent journal posting, stock receipt, or accounting publish from these tools.

## Tools

| Tool | When to use |
| --- | --- |
| `purchases` | Create/list/get/update/delete a vendor bill header, or `register_payment` for a supplier payment. Use first when starting a new PO / AP bill. |
| `purchase_items` | Add, list, update, or delete lines on an existing `purchase_id`. Use only after the header exists. |
| `catalog_commerce` | Look up or create catalog items before linking `catalog_item_id` on a purchase line. |
| `skill_lookup` | Load this skill (`makinari-purchases`) when the task involves vendor bills, PO, or accounts payable. |

## Artifacts

- **Produces**: `purchases` and `purchase_items` rows in the public schema (site-scoped AP records).
- **Consumes**: optional `companies` (vendor), `catalog_items`, `locations` UUIDs when provided by the user or prior tools.
