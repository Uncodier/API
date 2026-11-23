import {randomUUID} from 'node:crypto';
import {connectorToolRef, parseConnectorToolRef} from '../connector-ref';
import {METRICS_REPORT,parseInstanceToolRef,parseReportRef,reportRef} from '../instance-tool-ref';

const id=randomUUID(), other=randomUUID();
it('preserves both origin and local account in a reference; a provider slug is never a report alias',()=>{
  for(const account of [id,other]) {
    expect(parseInstanceToolRef(reportRef(account))).toEqual({origin:'makinari_report',connectorId:account});
    for(const slug of [METRICS_REPORT,'SUPABASE_RUN_READ_ONLY_QUERY','ASANA_LIST_TASKS']) {
      const name=connectorToolRef(account,slug);
      expect(parseInstanceToolRef(name)).toEqual({origin:'provider',connectorId:account,toolSlug:slug});
      expect(()=>parseReportRef(name)).toThrow();
    }
    expect(()=>parseConnectorToolRef(reportRef(account))).toThrow(); // Provider-only hosts do not inherit a report host.
  }
  expect(reportRef(id)).not.toBe(reportRef(other));
});
it.each(['report',`report:${id}:SUPABASE_RUN_READ_ONLY_QUERY`,`report:${id}:MAKINARI_METRICS\n`,
  `report:<${id}>:${METRICS_REPORT}`,`report:${id}:${METRICS_REPORT}:${other}`,`report:${id}:makinari_metrics`,
  `report:${other.replaceAll('-','_')}:${METRICS_REPORT}`])('rejects malformed, native or provider/report-confused references',name=>{
  expect(()=>parseInstanceToolRef(name)).toThrow(expect.objectContaining({code:'INVALID_TOOL_REFERENCE'}));
});