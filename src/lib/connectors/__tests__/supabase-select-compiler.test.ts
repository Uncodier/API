import { compileAnalyticsSelect } from '../supabase-select-compiler';
import { siteA, testDataset } from './supabase-select-fixture';

const dataset = testDataset({ workspace: siteA });
const compile = (q: unknown, params?: unknown) => compileAnalyticsSelect(q, params, dataset);
const base = 'select count(*) from analytics.sales';

test('regenerates one source, resolves every NAME, binds every literal, uses a separate caller namespace', () => {
  const q = `SELECT analytics.sales.currency AS bucket, COUNT(DISTINCT "site_id") AS offices, SUM(amount) AS revenue
    FROM "analytics"."sales" WHERE (currency = 'Customer''s €' OR amount >= $1) AND amount < $2
    AND amount <> $1 GROUP BY bucket ORDER BY SUM(amount) DESC LIMIT $3;`;
  const compiled = compile(q, ['912345678901234567.01', '912345678901234567.02', 4]);
  expect(compiled.limit).toBe(4);
  expect(compiled.source).toBe('sales');
  expect(compiled.columns).toEqual([{ name: 'bucket', type: 'text' }, { name: 'offices', type: 'integer' }, { name: 'revenue', type: 'numeric' }]);
  for (const value of [siteA, 'Customer', '912345678901234567', 'revenue', 'bucket', 'offices', compiled.attestation]) {
    expect(compiled.query).not.toContain(value);
  }
  expect(compiled.parameters).toEqual([siteA, "Customer's €", '912345678901234567.01', '912345678901234567.02', '912345678901234567.01', '5',
    'bucket', 'offices', 'revenue', compiled.attestation]);
  expect(compiled.query).toContain('site_id = $1::pg_catalog.uuid');
  expect(compiled.query).toContain('$3::pg_catalog.numeric');
  expect(compile(q, ['1', '2', 4]).query).toBe(compiled.query);
  expect(compile(q, ['1', '2', 4]).attestation).not.toBe(compiled.attestation);
});

test('quoted strings are values even when they contain SQL punctuation', () => {
  const value = "x; (y) -- z";
  const compiled = compile(`${base} WHERE currency = '${value}'`);
  expect(compiled.parameters).toContain(value);
  expect(compiled.query).not.toContain(value);
});

test.each([
  ['wrong input', 7], ['empty', ''], ['write', 'update analytics.sales set amount = 2'],
  ['two statements', `${base}; SELECT COUNT(*) FROM sales`], ['extra semicolon', `${base};;`],
  ['leading clause', 'with x as (select amount from sales) select count(*) from x'],
  ['join', `${base} join analytics.sales b on b.sale_date = sales.sale_date`], ['set op', `${base} UNION ${base}`],
  ['subquery', 'select count(*) from (select * from sales) as s'], ['lock', `${base} for update`],
  ['comment', `${base} /*extra*/`], ['trailing comment', `${base} -- tail`], ['offset', `${base} limit 2 offset 3`],
  ['bad schema', 'select count(*) from public.sales'], ['unknown table', 'select count(*) from invoices'],
  ['unknown column', 'select max(notes) from sales'], ['special object name', 'select count(*) from constructor'],
  ['projection star', 'select * from sales'], ['arithmetic', 'select sum(amount) + 1 from sales'],
  ['other fn', 'select length(currency) from sales'], ['no aggregate', 'select currency from sales group by currency'],
  ['ungrouped', 'select currency, sum(amount) from sales'], ['ambiguous alias', 'select avg(amount) k, min(units) k from sales'],
  ['wrong qualification', 'select sum(not_sales.amount) from sales'], ['original name after alias', 'select sum(sales.amount) from sales as a'],
  ['wrong group', 'select currency, min(amount) from sales group by paid'], ['group by aggregate alias', 'select sum(amount) as total from sales group by total'],
  ['uuid raw', 'select site_id, count(*) from sales group by site_id'], ['uuid filter', `${base} where site_id = 'x'`],
  ['uuid null check', `${base} where site_id is null`], ['uuid group', `${base} group by site_id`], ['uuid sort', `${base} order by site_id`],
  ['uuid minimum', 'select min(site_id) from sales'], ['unsupported count', 'select count(site_id) from sales'],
  ['typed string', `${base} where currency = 19`], ['typed boolean', `${base} where paid < false`],
  ['type mismatch', `${base} where units = date '2026-01-01'`], ['int overflow', `${base} where units = 9223372036854775808`],
  ['invalid day', `${base} where sale_date = date '2026-02-29'`], ['timestamp needs timezone', `${base} where created_at < '2026-11-04'`],
  ['identifier as value', `${base} where amount = units`], ['bad operator', `${base} where currency LIKE 'US%'`],
  ['unprojected sort', `${base} order by units`], ['unsupported order', `${base} order by 1`], ['invalid limit', `${base} limit 26`],
  ['duplicate group', `${base} group by units, units`], ['too many columns', 'select count(*) a,count(*) b,count(*) c,count(*) d,count(*) e,count(*) f from sales'],
  ['numeric trailing junk', `${base} where units >= 1and paid = true`], ['parameter trailing junk', `${base} where units = $1or paid = true`],
  ['predicate bound', `${base} where ${Array(17).fill('units = 1').join(' AND ')}`],
  ['nesting bound', `${base} where ((((((paid = false))))))`], ['query bytes', `${base}${' '.repeat(4096)}`],
])('rejects %s before any possible dispatch', (_name, request) => {
  const dispatch = jest.fn();
  expect(() => dispatch(compile(request))).toThrow(expect.objectContaining({ code: 'INVALID_TOOL_ARGUMENTS' }));
  expect(dispatch).not.toHaveBeenCalled();
});

test.each([
  [`${base} where amount < $1`, undefined], [`${base} where amount = $0`, [2]],
  [`${base} where amount = $2`, [1, 2]], [`${base} where amount = $1`, [1, 2]],
  [`${base} where amount = $1 and currency = $1`, ['2']], [`${base} where amount < $1`, [0.3]],
  [`${base} where amount < $1`, [9007199254740992]], [`${base} where amount < $1`, ['NaN']],
  [`${base} where amount < $1`, [Infinity]], [`${base} where units < $1`, ['9223372036854775808']],
  [`${base} where currency = $1`, ['hi\nthere']], [`${base} where currency = $1`, ['\uDFFF']],
  [`${base} where sale_date >= $1`, ['2025-02-29']], [`${base} where paid = $1`, ['no']],
  [`${base} where currency = $1`, [{ v: 'EUR' }]], [`${base} where units = $1`, [null]],
  [`${base} limit $1`, ['0']], [base, 'bad'], [base, Array(17).fill(1)],
])('rejects malformed or unused binds without dispatch %#', (q, params) => {
  const dispatch = jest.fn();
  expect(() => dispatch(compile(q, params))).toThrow(expect.objectContaining({ code: 'INVALID_TOOL_ARGUMENTS' }));
  expect(dispatch).not.toHaveBeenCalled();
});
