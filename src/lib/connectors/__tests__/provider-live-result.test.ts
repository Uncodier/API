import { randomUUID } from 'node:crypto';
import { secret } from './composio-fixtures';
import { projectProviderLiveResult, projectProviderSqlRows } from '../provider-live-result';

it('preserves business fields and scalar types but omits secrets, transport fields and unsupported values', () => {
  const key = secret(), bearer = secret(), project = randomUUID(), record = randomUUID();
  const url = new URL('https://example.test');
  url.username = 'test'; url.password = bearer;
  const data = {items:[{id:record,total:'9007199254740993.19',credit:0,paid:false,currency:null,label:'Quarterly earnings',
    unsafe:1e20,token:bearer, url:url.href, blob:'data:text/plain,content', echo:key, resource:project}],
    errors:[bearer],logs:[bearer],composio_execution_message:bearer};
  const out = projectProviderLiveResult(data,key,[project]);
  expect(out).toMatchObject({result:{items:[{id:record,total:'9007199254740993.19',credit:0,paid:false,currency:null,label:'Quarterly earnings'}]},withheld:true,truncated:false});
  expect(Object.keys((out.result as {items:object[]}).items[0])).toEqual(['id','total','credit','paid','currency','label']);
  for (const value of [key,bearer,project,url.href]) expect(JSON.stringify(out)).not.toContain(value);
});

it('keeps genuine empty data distinct from omissions and limits large results explicitly', () => {
  const key = secret();
  expect(projectProviderLiveResult({result:[]},key,[])).toMatchObject({result:{result:[]},withheld:false,truncated:false});
  expect(projectProviderLiveResult({rows:[{token:key}]},key,[])).toMatchObject({result:undefined,withheld:true});
  expect(projectProviderLiveResult(false,key,[]).result).toBe(false);
  const large = projectProviderLiveResult({rows:Array.from({length:125},(_,i)=>({i,text:'data '.repeat(400)}))},key,[]);
  expect(large.truncated).toBe(true);
  expect(Buffer.byteLength(JSON.stringify(large.result))).toBeLessThanOrEqual(20_000);
});

it('permits long aliases only as direct SQL column names while preserving secret filtering', () => {
  const key = secret(), opaqueKey = secret().slice(0, 48);
  const alias = 'subscriptions_with_positive_payments_at_close';
  const privateAlias = 'registered_accounts_for_current_project_scope';
  const recognizedPrefix = `sbp_${secret().slice(0, 10).replace(/\d/g, 'a')}_synthetic_fixture_for_test`;
  const rows = [{ [alias]: 0, [privateAlias]: 0, [opaqueKey]: 0, [recognizedPrefix]: 0,
    access_token_for_current_billing_period: 0, summary: { [alias]: 0, count: 0 }, note: alias }];

  const sql = projectProviderSqlRows(rows, key, [privateAlias]);
  expect(sql).toEqual({ result: { rows: [{ [alias]: 0, summary: { count: 0 } }] }, withheld: true, truncated: false });
  for (const value of [privateAlias, opaqueKey, recognizedPrefix, 'access_token_for_current_billing_period']) {
    expect(JSON.stringify(sql)).not.toContain(value);
  }
  expect(projectProviderLiveResult({ rows }, key, [privateAlias]).result).toEqual({ rows: [{ summary: { count: 0 } }] });
});