import { randomUUID } from 'node:crypto';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { executeScheduledConnectorStep } from '@/app/api/cron/workflows/connector-step';
import { workflowAccount, type WorkflowConnectorReadBinding } from '../workflow-read-binding';
import { describeWorkflowOperation } from '../workflow-read-descriptor';
import { accountFixture, jsonResponse, secret, toolFixture, toolkitFixture } from './composio-fixtures';

// Replace only external I/O. The real worker, descriptor, output check, report and finish path run.
jest.mock('../workflow-descriptor-markers', () => ({workflowDescriptorMarkers:async () => []}));
jest.mock('@/lib/database/supabase-client', () => ({supabaseAdmin:{rpc:jest.fn()}}));
jest.mock('../workflow-read-binding', () => ({...jest.requireActual('../workflow-read-binding'), workflowAccount:jest.fn()}));
const rpc = jest.mocked(supabaseAdmin.rpc);
const http = jest.fn(), originalFetch = global.fetch, originalFlag = process.env.WORKFLOW_CONNECTOR_READS_ENABLED;
const job = {run_id:randomUUID(),job_id:randomUUID()};
const toolkit = 'threadbook', slug = 'THREADBOOK_LIST_STAGES', version = '20261119_00', scope = 'stages.read';
const object = (properties:object, required = Object.keys(properties)) => ({type:'object',properties,required,additionalProperties:false});
const stages = {type:'array',items:object({stage:{type:'integer',minimum:1,maximum:6}}),minItems:1,maxItems:4};
let marker:string, binding:WorkflowConnectorReadBinding;
function setup(output:unknown, data:unknown, page:boolean, extraEnvelope = {}) {
  const site = randomUUID();
  const pin = {site_id:site,principal_id:randomUUID(),connector_id:randomUUID(),provider_id:randomUUID(),connector_revision:1,
    provider_project_id:'project_one',provider_user_id:site,provider_account_id:'ca_one',auth_config_id:'ac_one',
    credential_revision:secret(),tool_slug:slug,toolkit_slug:toolkit};
  binding = {...pin,schema_hash:'0'.repeat(64),toolkit_version:version,arguments:page?{page_size:2}:{}};
  jest.mocked(workflowAccount).mockResolvedValue({pin,credential:{source:'byok',apiKey:secret(),revision:pin.credential_revision},scopes:[scope]});
  http.mockImplementation(async (url:string) => {
    switch (new URL(url).pathname.replace('/api/v3.1','')) {
      case `/toolkits/${toolkit}`: return jsonResponse({...toolkitFixture(),slug:toolkit});
      case `/tools/${slug}`: return jsonResponse({...toolFixture(),slug,toolkit:{slug:toolkit},scopes:[scope],tags:['readOnlyHint'],description:'Lists stages.',
        input_parameters:object(page?{page_size:{type:'integer'}}:{}),output_parameters:output});
      case '/connected_accounts/ca_one': return jsonResponse({...accountFixture(),toolkit:{slug:toolkit},user_id:site,state:{authScheme:'OAUTH2',val:{scope}}});
      case `/tools/execute/${slug}`: return jsonResponse({successful:true,error:null,data,...extraEnvelope});
      default: throw new Error('Unexpected offline request');
    }
  });
  rpc.mockImplementation((name:string) => ({abortSignal:async () => ({data:name==='workflow_connector_finish'?true:binding,error:null})}) as never);
}
const describe = () => describeWorkflowOperation(binding.principal_id,{site_id:binding.site_id,connector_id:binding.connector_id,tool_slug:slug,arguments:binding.arguments});
async function run() {
  const dto = await describe();
  expect(Object.keys(dto).sort()).toEqual(['connector_id','input_schema','schema_hash','tool_slug','toolkit_slug','toolkit_version']);
  binding.schema_hash = dto.schema_hash;
  return executeScheduledConnectorStep(job);
}
beforeEach(() => {jest.resetAllMocks(); global.fetch=http; process.env.WORKFLOW_CONNECTOR_READS_ENABLED='true'; marker=secret();});
afterEach(() => {global.fetch=originalFetch; if (originalFlag===undefined) delete process.env.WORKFLOW_CONNECTOR_READS_ENABLED; else process.env.WORKFLOW_CONNECTOR_READS_ENABLED=originalFlag;});
const envelope = object({successful:{type:'boolean'},error:{type:['null','string']},data:stages});
it.each([
  ['wrong type', object({stage:{type:'integer'}}), () => ({stage:marker}), false],
  ['extra private field', object({stage:{type:'integer'}}), () => ({stage:2,secret:marker}), false],
  ['missing required', object({stage:{type:'integer'}}), () => ({}), false],
  ['wrong root', stages, () => ({stage:2}), true],
  ['numeric maximum', stages, () => [{stage:7}], false],
  ['too few', stages, () => [], false],
  ['schema maximum', stages, () => Array(5).fill({stage:2}), false],
  ['page size', object({items:stages}), () => ({items:Array(3).fill({stage:2})}), true],
  ['no schema page size', undefined, () => ({nested:{items:Array(3).fill(marker)}}), true],
  ['enum', object({stage:{type:'string',enum:['ready','waiting']}}), () => ({stage:marker}), false],
  ['maxLength', object({stage:{type:'string',maxLength:2}}), () => ({stage:marker}), false],
  ['closed envelope', envelope, () => [{stage:1}], true],
  ['malformed envelope payload',envelope, () => [{stage:marker}],true],
] as const)('never finishes an invalid result: %s',async (label,schema,data,page) => {
  setup(schema,data(),page,label==='closed envelope'?{diagnostic:marker}:{});
  await expect(run()).rejects.toThrow(/^Scheduled connector outcome could not be confirmed\. Do not replay this occurrence\.$/);
  expect(http.mock.calls.filter(c => c[1].method==='POST')).toHaveLength(1);
  expect(rpc.mock.calls.map(c => c[0])).toEqual(['workflow_connector_prepare','workflow_connector_dispatch']);
  expect(JSON.stringify(rpc.mock.calls)).not.toContain(marker);
});
it.each([
  ['envelope', envelope, [{stage:4}], true], ['data array',stages,[{stage:4}],false],
  ['no schema bounded page',null,[{stage:4}],true],
  ['referenced envelope',{$ref:'#/$defs/Result',$defs:{Result:envelope}},[{stage:4}],true],
] as const)('finishes only the redacted preview: %s',async (_,schema,data,page) => {
  setup(schema,data,page); expect(await run()).toBe('completed');
  expect(rpc.mock.calls[2]).toEqual(['workflow_connector_finish',expect.objectContaining({p_result:{executed:true,report:expect.objectContaining({rows:[['$[0].stage','4']]})}})]);
});
it.each([
  [undefined,false], [{},true], [{type:'string',items:{type:'number'}},true],
  [{type:'array',items:{type:'integer'}},false], [object({code:{type:'integer',multipleOf:2}}),true],
  [{type:'integer',anyOf:[{type:'string'}]},false], [{type:'integer',minLength:2},false], [{type:'integer',const:'seven'},true],
])('rejects uncheckable semantics at review',async (schema,page) => {
  setup(schema,{},Boolean(page)); await expect(describe()).rejects.toThrow(); expect(rpc).not.toHaveBeenCalled();
  expect(http.mock.calls.filter(c => c[1].method==='POST')).toHaveLength(0);
});
