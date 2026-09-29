# Daily Standup report sections

## Contract and trust boundaries

Persist preferences at `settings.activities.daily_resume_and_stand_up`:

```json
{
  "status": "active",
  "weekdays": [1, 5],
  "report_sections": ["sales", "tasks", "requirements", "social", "channels", "records", "orders", "reservations", "inventory"]
}
```

- Missing `report_sections` preserves all nine sections. Explicit empty, null, non-array, or any unknown key fails closed. Valid duplicates are deduplicated in canonical order. Legacy `active`/`inactive` string settings have no section field and retain the missing-field default.
- `POST /api/agents/cmo/dailyStandUp/wrapUp` accepts optional top-level `report_sections`. Malformed values return 400. Valid values are intersected with the **latest** persisted settings; they can narrow but never broaden selection. An empty intersection returns 409 before business-data queries or processor initialization.
- Settings/data read errors return 500, never a report claiming zero activity. No schema fallback enables other sections. Only absent preferences get defaults.
- Optional UUID `command_id`/`command_ids` remain accepted for wire compatibility, but prior commands, memories, platform announcements and generic site settings are no longer report inputs. Client-supplied context/targets/other extra fields are not used.
- Each selected source is read only when selected. The prompt projects selected datasets again. The command carries an explicit scoped `agent_background` to prevent `AgentInitializer` / `initializeAgentCommand` from fetching general agent/site context. There are no tools or supervisors attached.
- Model results must contain a `sections` object with **exactly** the selected keys and nonempty string values; unexpected or missing keys fail with 502. The server assembles headings and a fixed subject. Generic model `message`, `summary`, `health`, or `systemAnalysis` are never used as fallback. Section prose is model-generated, with evidence-only instructions; this structural guard is not a semantic classifier of every sentence.
- Success returns `data.{subject,message,summary,command_id,report_sections}` (`summary` equals `message`). It does not return global health, system analysis or legacy leads/message summaries. A selection revoked during generation returns 409 instead of exposing the report.

## Confirmed source coverage

All reads are site-scoped, explicit-column projections. No arbitrary JSON blobs, secrets, linked sales/payment objects, or cross-department memories are included. Each dataset is capped at 200 rows, with a 201st row used to signal `truncated`. `sampled_count` is not a total.

| Section | Source / projection | Time scope and evidence |
| --- | --- | --- |
| Sales | `sales`: id, title, status, amount, currency, created_at; `leads`: id, name, status, created_at | Created in previous UTC day. Confirmed by API `agents/tools/checkout/create-order.ts`, customerSupport `lead-record.ts`, and existing lead collector. No messages or channel data. |
| Tasks | `tasks`: id, title, status, priority, scheduled_date, completed_date, created_at | Created in previous UTC day. `src/lib/database/task-db.ts` confirms columns. This is not the full open-task backlog. |
| Requirements | `requirements`: id, title, status, priority, completion_status, created_at | Created in previous UTC day. `src/lib/database/requirement-db.ts` confirms columns. No metadata, instructions or agent plans. |
| Social | `content` filtered to `type=social_post`: id, title, status, published_at, created_at; `content_performance`: id, content_id, outstand_post_id, likes, comments, shares, views, impressions, reach, fetched_at | Current local posts and cached cumulative provider metrics, not daily deltas. Confirmed by API content-db and Workflows `outstandActivities.ts` writer / market-fit `social-queries.ts`. No provider calls, raw account metrics, comments/messages or uncertain engagement-rate units. |
| Channels | Latest `settings.channels`, reduced to status/enabled for email, agent_email/agent_mail/agent, whatsapp, agent_whatsapp, plus type/status/enabled of `connections` | Current configuration only, **not live delivery health**. Confirmed by API LeadFollowUpChannelHelper and Workflows outreachConfiguration. Credentials/identifiers/raw connection metadata are never put into report inputs. Social network connection configuration belongs here; engagement metrics belong to Social. |
| Records | `records`: id, title, status, created_at | Created in previous UTC day. Confirmed by API record create/get and market-fit Records type. No generic data/relations/description/summary blobs that could contain other business sections. |
| Orders | `sale_orders`: id, order_number, status, total, currency, created_at | Created in previous UTC day. Confirmed by API checkout writer and market-fit Orders screen/actions. Deliberately not the legacy `orders` table used by older sales-order tools; no joined sales/payments. |
| Reservations | `reservations`: id, status, start_time, end_time, quantity, joined `catalog_items!inner(site_id)` | Started in previous UTC day. Scope through the inner catalog-item relationship; no assumed reservations.site_id column. Confirmed by API reservations list tool. Tenant join field is removed from returned inputs. |
| Inventory | `inventory_levels`: id, catalog_item_id, location_id, quantity, updated_at; `catalog_items!inner(name,sku,site_id)` | Current quantities by item/location, not daily movements. Both inventory and catalog relationship constrained to site. Confirmed by market-fit `app/inventory/actions.ts` and InventoryLevel type. No invented reserved quantity, reorder point, movement history or availability-only substitute. |

Previous-day ranges are `[00:00 UTC yesterday, 00:00 UTC today)`, preserving the former collector's UTC reporting window. Scheduling/notification weekdays are evaluated separately in the site's timezone. Snapshots are labeled as snapshots, and no missing metric becomes a fabricated zero. Currency amounts must not be treated as interchangeable across currencies.

## Delivery safety

`POST /api/notifications/dailyStandUp` accepts the same optional `report_sections`. On every delivery attempt it re-reads current settings and rejects stale/mismatched selection, inactive status, invalid days/timezone or an unselected local weekday (409). A settings read error prevents delivery. Missing weekdays default to Monday/Friday; missing timezone defaults to `America/Mexico_City`, matching Workflows. Unscoped legacy requests are accepted only when all nine sections remain selected and current status/day permit delivery.

Scoped notifications suppress legacy `health` and `systemAnalysis` assessment panels entirely, even if callers supply them. The notification endpoint is a presentation/delivery boundary, not an independent semantic validator of arbitrary caller prose. Workflows must forward only a successful scoped report and its `report_sections`, and recheck preferences before send; notification retries recheck preferences again.

## Offline validation

```sh
node ./node_modules/jest/bin/jest.js --config jest.standup.config.js --runInBand
```

The suite exercises source queries, tenant joins, secret projection, default/invalid selection, context/output enforcement, actual command initialization/target message formatting, wrap-up requests/results and rendered notification HTML. Database access, command/LLM execution and notification delivery are mocked; it loads no `.env`, performs no live requests or mutations, and sends nothing.