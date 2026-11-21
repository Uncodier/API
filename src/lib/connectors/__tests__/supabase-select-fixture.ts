import type { AnalyticsDataset } from '../supabase-select-compiler';

export const siteA = '00000000-0000-4000-8000-000000000001';
export const siteB = '00000000-0000-4000-8000-000000000002';
type Scope = { workspace: typeof siteA | typeof siteB } | { global: true };

/** Synthetic capability supplied by a trusted test host: caller SELECTs cannot choose its scope. */
export function testDataset(scope: Scope): AnalyticsDataset {
  const tenant = 'workspace' in scope;
  const columns = { site_id: 'uuid', sale_date: 'date', created_at: 'timestamptz', currency: 'text', amount: 'numeric',
    units: 'integer', paid: 'boolean' } as const;
  return { ...(tenant && { allowRows: true as const }), parameters: tenant ? [scope.workspace] : [], sources: {
    sales: { columns, money: { currency: 'currency', measures: ['amount'] }, guardSql: "NOT pg_catalog.row_security_active('public.test_sales'::pg_catalog.regclass)",
      sql: `SELECT site_id, sale_date, created_at, currency, amount, units, paid FROM ONLY public.test_sales${tenant ? ' WHERE site_id = $1::pg_catalog.uuid' : ''}` },
    // KPI source: joins and its inner aggregation are entirely server-defined. Both legs are
    // scoped, including joins on the natural workspace-local product key (not globally unique).
    baskets: { columns: { sale_date: 'date', net: 'numeric', currency: 'text' }, money: { currency: 'currency', measures: ['net'] }, guardSql: 'true',
      sql: `SELECT s.site_id, s.sale_date, s.currency, pg_catalog.sum(s.amount - f.fee) AS net
        FROM ONLY public.test_sales AS s JOIN ONLY public.test_fees AS f ON f.site_id = s.site_id AND f.currency = s.currency
        ${tenant ? 'WHERE s.site_id = $1::pg_catalog.uuid AND f.site_id = $1::pg_catalog.uuid' : ''}
        GROUP BY s.site_id, s.sale_date, s.currency` },
  } };
}
