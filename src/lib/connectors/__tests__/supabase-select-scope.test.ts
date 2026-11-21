import { compileAnalyticsSelect } from '../supabase-select-compiler';
import { testDataset, siteA } from './supabase-select-fixture';

const workspace = testDataset({ workspace: siteA }), platform = testDataset({ global: true });
const compile = (query: string, parameters?: unknown) => compileAnalyticsSelect(query, parameters, workspace);
const row = 'SELECT s.currency AS unit, s.amount AS price FROM analytics.sales s WHERE s.paid = true ORDER BY price DESC';

test('workspace facts need explicit trusted row admission; a scope parameter cannot grant it', () => {
  const plan = compile(row);
  expect(plan.columns).toEqual([{ name:'unit', type:'text' }, { name:'price', type:'numeric' }]);
  expect(plan.limit).toBe(25);
  expect(plan.parameters).toContain('26');
  expect(plan.query).toContain('ORDER BY v1 DESC, v0 ASC');
  for (const denied of [platform, { ...workspace, allowRows: undefined }, Object.assign(Object.create({allowRows:true}), platform)]) {
    const dispatch = jest.fn();
    expect(() => dispatch(compileAnalyticsSelect(row, undefined, denied))).toThrow('requires an aggregate');
    expect(dispatch).not.toHaveBeenCalled();
  }
});

test.each([
  'select site_id from sales', 'select units from sales where site_id is not null', 'select units from sales order by site_id',
  'select site_id as currency from sales', 'select * from sales', 'select amount, count(*) from sales',
  'select mystery from sales', 'select amount + units from sales', 'select count(*) from sales group by site_id',
])('workspace row admission does not widen identifier, expression or aggregate rules: %s', (query) => {
  expect(() => compile(query)).toThrow(expect.objectContaining({ code: 'INVALID_TOOL_ARGUMENTS' }));
});

test.each([
  ['select sum(amount) from sales'], ['select avg(amount) from sales group by currency'],
  ['select max(amount), sale_date as currency from sales group by sale_date'], ['select min(amount) from sales where currency is not null'],
  ["select sum(amount) from sales where currency = 'USD' or paid = true"],
  ["select sum(amount) from sales where (paid=true and currency='USD') or (paid=false and currency='EUR')"],
  ["select sum(amount) from sales where paid=true and (currency='USD' or currency='EUR')"],
  ["select sum(amount) from sales where currency <> 'USD'"], ["select sum(amount) from sales where currency = 'usd'"],
  ['select sum(amount) from sales where currency = $1', ['US']], ['select sum(amount) from sales where currency = $1', ['USD ']],
  ['select sum(amount) from sales where currency = $1', ['US1']],
])('denies an unproved single currency before dispatch %#', (...[query, params]) => {
  const dispatch = jest.fn();
  expect(() => dispatch(compile(query, params))).toThrow('For monetary aggregates');
  expect(dispatch).not.toHaveBeenCalled();
});

test('aliases, aggregate ORDER BY and equality-bound monetary units are resolved from the AST', () => {
  const byCurrency = compile('select s.currency unit, max(s.amount) high from sales s group by unit order by max(s.amount)');
  expect(byCurrency.columns).toEqual([{ name:'unit', type:'text' }, { name:'high', type:'numeric' }]);
  const filtered = compile('select min(amount) from sales where (paid=true or units>1) and currency = $1', ['CAD']);
  expect(filtered.parameters).toContain('CAD'); expect(filtered.query).not.toContain('CAD');
  expect(compileAnalyticsSelect('select count(*) from sales', undefined, platform).columns).toEqual([{ name:'count', type:'integer' }]);
});
