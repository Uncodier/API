import { secret } from './composio-fixtures';
import { supabaseSqlAction, supabaseSqlRows, supabaseSqlReport } from '../supabase-sql-result';

const beta = 'SUPABASE_BETA_RUN_SQL_QUERY', read = 'SUPABASE_RUN_READ_ONLY_QUERY';
const betaData = {command:'SELECT',composio_execution_message:null,result:[{connector_probe:1}],rows_affected:1};

it('recognizes only the two SQL actions and validates their different response shapes', () => {
  expect(supabaseSqlAction('supabase', beta)).toBe(beta);
  expect(supabaseSqlAction('supabase', read)).toBe(read);
  expect(supabaseSqlAction('other', beta)).toBeUndefined();
  expect(supabaseSqlAction('supabase', 'SUPABASE_LIST_TABLES')).toBeUndefined();
  const result = betaData.result;
  expect(supabaseSqlRows(beta, betaData)).toEqual(result);
  expect(supabaseSqlRows(read, {result,rows_returned:1})).toEqual(result);
  expect(supabaseSqlRows(read, {result})).toEqual(result);
  for (const data of [{...betaData,command:'UPDATE'}, {...betaData,rows_affected:0}, {...betaData,result:null}, {...betaData,result:[1]}, {data:betaData}, {result}]) {
    expect(supabaseSqlRows(beta, data)).toBeUndefined();
  }
  for (const data of [{result,rows_returned:0}, {result,rows_affected:1}, {result,logs:[]}, result]) {
    expect(supabaseSqlRows(read, data)).toBeUndefined();
  }
});

it('formats private KPI values without rounding exact text or exposing sensitive fields', () => {
  const key = secret(), token = secret();
  const url = new URL('https://example.test/result');
  url.password = token; url.username = 'synthetic';
  const report = supabaseSqlReport([{currency:'MXN',total:'9007199254740993.01',nullable:null,comment:key,link:url.href,access_token:token}], key);
  expect(report).toMatchObject({columns:['currency','total','nullable','comment','link'],
    rows:[['MXN','9007199254740993.01','null','[withheld]','[withheld]']],note:expect.stringContaining('omitted')});
  expect(JSON.stringify(report)).not.toContain(key);
  expect(JSON.stringify(report)).not.toContain(token);
  expect(JSON.stringify(report)).not.toContain(url.href);
});

it('reports unsupported and empty results differently and marks partial previews', () => {
  const key = secret();
  expect(supabaseSqlReport(undefined, key).note).toContain('does not confirm an empty result');
  expect(supabaseSqlReport([], key).note).toContain('returned no rows for this query');
  expect(supabaseSqlReport([{count:7}, null], key)).toMatchObject({rows:[],note:expect.stringContaining('does not confirm an empty result')});
  expect(supabaseSqlReport([{total:1e20}], key).rows).toEqual([['[withheld]']]);
  const report = supabaseSqlReport(Array.from({length:110}, (_, i) => ({a:i,b:2,c:3,d:4,e:5,f:6})), key);
  expect(report.columns).toEqual(['a','b','c','d','e']);
  expect(report.rows).toHaveLength(100);
  expect(report.note).toContain('truncated');
  const bounded = supabaseSqlReport(Array.from({length:100}, () => ({a:'x '.repeat(100),b:'x '.repeat(100),c:'x '.repeat(100),d:'x '.repeat(100),e:'x '.repeat(100)})), key);
  expect(Buffer.byteLength(JSON.stringify(bounded))).toBeLessThan(65_536);
  expect(bounded.rows.length).toBeLessThan(100);
  expect(bounded.note).toContain('truncated');
});