import {randomBytes} from 'node:crypto';
import {directOutputReport} from '../provider-direct-output';

const credential = randomBytes(32).toString('hex');
it('presents nested business fields, explicit null, empty collections and provider row positions without a toolkit adapter', () => {
  const result = directOutputReport({items:[{label:'Revenue',amount:'123.45',settled:false,missing:null}],next:[]},credential);
  expect(result.rows).toEqual([['$.items[0].label','Revenue'],['$.items[0].amount','123.45'],['$.items[0].settled','false'],
    ['$.items[0].missing','null'],['$.next','[]']]);
});
it('does not store secrets or credentials under a sensitive field, in a URL, as a field name, or in an otherwise innocuous value', () => {
  const secret = randomBytes(32).toString('hex');
  const data = {oauth:{record:secret}, apiKey:secret, logs:[{body:secret}], plain:credential,
    [credential]:3, literal:`Bearer ${secret}`, link:`https://example.test/?signature=${secret}`, safe:'Ready'};
  const report = directOutputReport(data,credential);
  expect(report.rows).toEqual([['$.safe','Ready']]);
  expect(report.note).toContain('omitted');
  expect(JSON.stringify(report)).not.toContain(secret);
  expect(JSON.stringify(report)).not.toContain(credential);
});
it('does not render rounded large integers or silently treat a bounded preview as complete', () => {
  const report = directOutputReport({unsafe:1e20,rows:Array(200).fill('visible')},credential);
  expect(report.rows).toHaveLength(100);
  expect(report.note).toMatch(/omitted.*truncated/);
  expect(report.rows.flat()).not.toContain('$.unsafe');
  expect(Buffer.byteLength(JSON.stringify(report))).toBeLessThan(65536);
});