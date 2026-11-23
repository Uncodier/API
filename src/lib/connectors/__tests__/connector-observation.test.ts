import { randomBytes, randomUUID } from 'node:crypto';
import { connectorObservation as observe } from '../connector-observation';

const id = randomUUID();
const privateText = randomBytes(24).toString('hex');
const provider = `connector:${id}:${privateText.toUpperCase()}`;
const report = `report:${id}:MAKINARI_METRICS`;
const safe = (action: string, tool_origin?: string) => ({action, private_arguments:true, ...(tool_origin && {tool_origin})});

describe('lossy shared observations (not evidence of dispatch)', () => {
  it.each([[provider,'provider'],[report,'makinari_report'],[` REPORT :bad:${privateText}`,'makinari_report'],['connector:','provider']])(
    'classifies reserved namespace case %# without copying any part of the reference', (name, origin) => {
      for (const action of ['describe','call']) {
        expect(observe('tools',{action,name,args:{body:privateText}})).toEqual(safe(action, origin));
        expect(observe('use_composio_tools',{action:action==='call'?'execute':action,action_name:name})).toEqual(safe(action, origin));
      }
      expect(observe(name,{query:privateText})).toEqual(safe('call', origin));
    });

  it('uses only exact origin enums for opt-in search and list, even if an input is malformed', () => {
    for (const action of ['search','list']) {
      for (const origin of ['provider','makinari_report',null,{},privateText,undefined]) {
        const args = {action, tool_origin:origin, query:privateText, account_label:privateText};
        expect(observe('tools',args)).toEqual(safe(action,origin === 'provider' || origin === 'makinari_report' ? origin : undefined));
      }
      for (const key of ['connector_id','connector_cursor','catalog_query']) {
        expect(observe('tools',{action, [key]:null, query:privateText})).toEqual(safe(action, key === 'connector_id' ? 'provider' : undefined));
      }
    }
    expect(observe('tools',{action:privateText,name:`report:${privateText}`})).toEqual(safe('connector','makinari_report'));
    expect(observe('tools',{action:'call',name:{secret:privateText}})).toEqual(safe('call'));
  });

  it('protects both gateway wire formats, even truncated or unparsable ones, without invoking getters', () => {
    const args = {action:'execute',action_name:report,action_params:privateText};
    for (const wire of [args, JSON.stringify(args)]) {
      expect(observe('tools',{action:'call',name:'use_composio_tools',args:wire})).toEqual(safe('call','makinari_report'));
    }
    expect(observe('tools',`{"name":"report:${privateText}`)).toEqual(safe('connector'));
    expect(observe('tools',{action:'call',name:'use_composio_tools',args:privateText})).toEqual(safe('connector'));
    const getter = jest.fn(() => { throw Error('not evaluated'); });
    expect(observe('tools',Object.defineProperty({action:'call'}, 'name', {get:getter}))).toEqual(safe('call'));
    expect(getter).not.toHaveBeenCalled();
  });

  it('protects mixed discovery, cursor-only and implicitly pinned results; native-only searches still have diagnostics', () => {
    for (const action of ['search','list']) {
      const args = {action, query:privateText};
      const native = {query:privateText, tools:[{name:'report'}], connector_status:'available',connector_next_cursor:null};
      expect(observe('tools',args,native)).toBeUndefined();
      expect(observe('tools',args,{...native, tools:[...native.tools, {name:provider, connector_id:id, account_label:privateText}]})).toEqual(safe(action));
      expect(observe('tools',args,{...native,connector_next_cursor:privateText})).toEqual(safe(action));
      expect(observe('tools',args)).toEqual(safe(action)); // provisional observation
    }
    expect(observe('tools',{action:'search',query:privateText},{connector_status:'unavailable',tools:[]})).toEqual(safe('search'));
    expect(observe('tools',{action:'search',query:report},{query:report,tools:[]})).toEqual(safe('search','makinari_report'));
  });

  it('does not turn the native report, unrelated tools, or ordinary skill reads into private operations', () => {
    expect(observe('tools',{action:'call',name:'report',args:JSON.stringify({action:'list'})})).toBeUndefined();
    expect(observe('report',{action:'list',connector_id:id})).toBeUndefined();
    expect(observe('webSearch',{action:'search',query:privateText})).toBeUndefined();
    expect(observe('skill_lookup',{action:'get'},{connector_capabilities:{capabilities:[]}})).toBeUndefined();
    expect(observe('skill_lookup',{action:'get'},{connector_capabilities:{capabilities:[{connector_id:id}]}})).toEqual(safe('get'));
  });
});
