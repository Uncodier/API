import { baseGuard } from './supabase-analytics-guards';
import type { AnalyticsScope } from './supabase-analytics-sources';
import type { AnalyticsSource } from './supabase-select-types';

export const NATIVE_SOURCE_NAMES: ReadonlySet<string> = new Set(['paid_sales','tender_awards','approved_orders']);
const sale = { site_id:'uuid',sale_date:'date',currency:'text',amount:'numeric' } as const;
const procurement = { site_id:'uuid',created_at:'timestamptz',currency:'text',net_amount_minor:'integer',tax_amount_minor:'integer' } as const;
const award = { id:'uuid',site_id:'uuid',quotation_id:'uuid',supplier_id:'uuid' } as const;
const approval = { id:'uuid',site_id:'uuid',target_id:'uuid',event:'text',status:'text' } as const;
const purchaseMoney = { currency:'currency', measures:['net_amount_minor','tax_amount_minor'] } as const;
const approved = baseGuard('public','procurement_event_approvals',approval);
// Unspecified currency remains NULL, not default USD. Avoid projecting arbitrary text from a legacy currency field.
const currency = (alias:string) => `CASE WHEN pg_catalog.btrim(${alias}.currency) COLLATE pg_catalog."C" ~ '^[a-zA-Z]{3}$'
  THEN pg_catalog.upper(pg_catalog.btrim(${alias}.currency) COLLATE pg_catalog."C") END AS currency`;

/** Explicit physical columns and site equality on every joined leg in BOTH workspace and platform plans. */
export function nativeSources(scope: AnalyticsScope): Record<string, AnalyticsSource> {
  const where = (site: string) => scope === 'workspace' ? ` AND ${site} = $1::pg_catalog.uuid` : ` AND ${site} IS NOT NULL`;
  return {
    paid_sales: { columns:sale, money:{currency:'currency', measures:['amount']},
      guardSql:baseGuard('public','sales',{...sale,status:'text',amount_due:'numeric'}),
      sql:`SELECT s.site_id, s.sale_date, ${currency('s')}, s.amount FROM ONLY "public"."sales" AS s
        WHERE s.status = 'completed' AND s.amount_due = 0${where('s.site_id')}` },
    tender_awards: { columns:procurement, money:purchaseMoney,
      guardSql:[baseGuard('public','procurement_awards',{...award,tender_id:'uuid',approval_id:'uuid',created_at:'timestamptz'}),
        baseGuard('public','quotations',{id:'uuid',purpose:'text',buyer_site_id:'uuid',procurement_tender_id:'uuid',procurement_supplier_id:'uuid',
          currency:'text',procurement_net_minor:'integer',procurement_tax_minor:'integer'}),approved].join(' AND '),
      sql:`SELECT a.site_id, a.created_at, ${currency('q')}, q.procurement_net_minor AS net_amount_minor, q.procurement_tax_minor AS tax_amount_minor
        FROM ONLY "public"."procurement_awards" AS a JOIN ONLY "public"."quotations" AS q ON q.purpose = 'procurement'
          AND (q.buyer_site_id,q.id,q.procurement_tender_id,q.procurement_supplier_id) = (a.site_id,a.quotation_id,a.tender_id,a.supplier_id)
        JOIN ONLY "public"."procurement_event_approvals" AS e ON (e.site_id,e.id,e.target_id) = (a.site_id,a.approval_id,a.quotation_id)
        WHERE e.event = 'award' AND e.status = 'approved'${where('a.site_id')}` },
    approved_orders: { columns:procurement, money:purchaseMoney,
      guardSql:[baseGuard('public','purchase_orders',{...procurement,award_id:'uuid',approval_id:'uuid',quotation_id:'uuid',supplier_id:'uuid'}),
        baseGuard('public','procurement_awards',award),approved].join(' AND '),
      sql:`SELECT o.site_id, o.created_at, ${currency('o')}, o.net_amount_minor, o.tax_amount_minor
        FROM ONLY "public"."purchase_orders" AS o JOIN ONLY "public"."procurement_awards" AS a ON
          (a.site_id,a.id,a.quotation_id,a.supplier_id) = (o.site_id,o.award_id,o.quotation_id,o.supplier_id)
        JOIN ONLY "public"."procurement_event_approvals" AS e ON (e.site_id,e.id,e.target_id) = (o.site_id,o.approval_id,o.award_id)
        WHERE e.event = 'order' AND e.status = 'approved'${where('o.site_id')}` },
  };
}
