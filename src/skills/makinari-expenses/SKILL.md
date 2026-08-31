---
name: makinari-expenses
description: Register general expenses, salaries, payroll, and operating costs as financial transactions. Use when the user asks to log a gasto, salary, salario, fixed/variable cost, or expense — not vendor bills, purchase orders, or customer checkout.
types: ['automation', 'task', 'integration']
---

# Makinari Expenses (Transactions)

## Objective

Equip the agent to record site-owned operating expenses (salaries, rent, utilities, general gastos) in the `transactions` table. These are not vendor bills and not customer sales.

## Instructions

1. **Do not confuse expense vs purchase vs checkout**
   - **Expense (this skill):** a general cost with no supplier bill or catalog line — salary, payroll, rent, utilities, fees. Use `transactions`.
   - **Vendor bill / PO:** money owed to a supplier with a bill header and line items. Use `makinari-purchases` (`purchases` + `purchase_items`). Never this tool.
   - **Buyer checkout:** a customer buying from us. Use `makinari-commerce` (`checkout`). Never this tool.

2. **When the user says "gasto", "expense", "salario", or "salary"**
   - ALWAYS use `tools` → `transactions` with `action="create"`.
   - NEVER create a `purchases` header for this. A purchase/bill is the wrong record type.

3. **Create workflow (`transactions`)**
   - Required: `type` (`fixed` or `variable`) and `amount` (positive number).
   - `fixed`: recurring/predictable costs (salary, rent, subscriptions).
   - `variable`: one-off or fluctuating costs (travel, ads, repairs).
   - Set `description` clearly (e.g. "Salary - August", "Office rent").
   - Set `category` when known (e.g. "Salaries & Benefits", "Rent", "Utilities").
   - `date` is YYYY-MM-DD (defaults to today). `currency` defaults to USD.
   - `site_id` and `user_id` are injected by the tool; do not invent them.

4. **List / get / update / delete**
   - `list` to search expenses (filter by `type`, `category`, `currency`).
   - `get` / `update` / `delete` require the transaction `id`.

5. **Anti-patterns**
   - Do NOT use `purchases` or `purchase_items` for salaries or general expenses.
   - Do NOT use `checkout`, `sales`, or `sales_order` for outbound costs.
   - Do NOT invent accounting journal posts from this tool.

## Tools

| Tool | When to use |
| --- | --- |
| `transactions` | Create/list/get/update/delete an expense or salary record. Default tool for gastos. |
| `purchases` | Only if the user actually has a vendor invoice / PO — then switch to `makinari-purchases`. |
| `skill_lookup` | Load this skill (`makinari-expenses`) for expenses, salaries, payroll, or operating costs. |

## Artifacts

- **Produces**: `transactions` rows in the public schema (site-scoped expense records).
- **Consumes**: optional category/description/date/currency from the user request.
