import { randomBytes } from 'node:crypto';
import { createAssistantOnStepHandler } from '../assistant-logging';
import { AssistantExecutionBoundaryError } from '../assistant-execution-boundary';
import { supabaseAdmin } from '@/lib/database/supabase-client';

jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { from: jest.fn() } }));
const writes: any[] = [];
let failAt: string | undefined;
beforeEach(() => {
  jest.clearAllMocks(); writes.length = 0; failAt = undefined;
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.mocked(supabaseAdmin.from).mockImplementation(() => ({
    insert: (payload: any) => {
      writes.push(payload);
      if (failAt === 'throw') throw new Error('database unavailable');
      const error = failAt === payload.log_type ? { message: 'database unavailable' } : null;
      return { error, select: () => ({ single: async () => ({ data: failAt === 'missing-parent' ? null : { id: 'parent' }, error }) }) };
    },
    update: () => ({ eq: async () => ({ error: { message: 'database unavailable' } }) }),
  }) as any);
});
afterEach(() => jest.restoreAllMocks());

function handler(redact?: (value: string) => string) {
  return createAssistantOnStepHandler('instance', 'site', 'user', 'openrouter', undefined, undefined, 'requirement', undefined, { strict: true, redact });
}
function step(value = 'ordinary text') {
  return { text: value, usage: { promptTokens: 7, completionTokens: 2, totalTokens: 9, cost: 0.005 },
    toolCalls: [{ toolCallId: 'stable', toolName: 'lookup', args: { thought_process: value, nested: { value } } }],
    toolResults: [{ toolCallId: 'stable', result: { success: true, data: value } }] };
}

it('redacts detached serialized step, reasoning, arguments, results, and console while preserving canonical usage', async () => {
  const sensitive = randomBytes(24).toString('hex');
  const original = step(sensitive);
  await handler(value => value.replaceAll(sensitive, '[REDACTED]'))(original);
  expect(writes).toHaveLength(3);
  expect(JSON.stringify(writes)).not.toContain(sensitive);
  expect(JSON.stringify(jest.mocked(console.log).mock.calls)).not.toContain(sensitive);
  expect(writes[0].details.raw_text).toBe('[REDACTED]');
  expect(writes[2].tool_args.nested.value).toBe('[REDACTED]');
  expect(writes[2].tool_result.output.data).toBe('[REDACTED]');
  expect(writes[0].tokens_used).toEqual(original.usage);
  expect(writes[2].tokens_used).toEqual(original.usage);
  expect(original.text).toBe(sensitive);
});

it.each(['agent_action', 'thinking', 'tool_call', 'missing-parent', 'throw'])('fails closed on %s persistence failure', async mode => {
  failAt = mode;
  await expect(handler()(step())).rejects.toBeInstanceOf(AssistantExecutionBoundaryError);
  await expect(handler()(step())).rejects.toMatchObject({ code: mode === 'throw' ? 'boundary_failed' : 'assistant_log_failed' });
});

it('fails closed on streaming update errors and unavailable instance identity', async () => {
  await expect(handler()(step(), { streamingLogId: 'existing' })).rejects.toMatchObject({ name: 'RecoveryError' });
  const missing = createAssistantOnStepHandler(undefined, 'site', 'user', 'openrouter', undefined, undefined, undefined, undefined, { strict: true });
  await expect(missing(step())).rejects.toMatchObject({ name: 'RecoveryError' });
});

it('never logs or persists raw data if redaction fails', async () => {
  const sensitive = randomBytes(24).toString('hex');
  await expect(handler(() => { throw new Error(sensitive); })(step(sensitive))).rejects.toMatchObject({ name: 'RecoveryError' });
  expect(writes).toHaveLength(0);
  expect(JSON.stringify(jest.mocked(console.log).mock.calls)).not.toContain(sensitive);
  expect(JSON.stringify(jest.mocked(console.error).mock.calls)).not.toContain(sensitive);
});

it('keeps legacy database error behavior without strict mode', async () => {
  failAt = 'agent_action';
  await expect(createAssistantOnStepHandler('instance', 'site', 'user', 'openrouter')(step())).resolves.toBeUndefined();
});

it.each(['tools','use_composio_tools'])('omits private connector arguments from shared log payload, message and reasoning for %s',async toolName=>{
  const text=randomBytes(24).toString('hex');
  const args={action:toolName==='tools'?'call':'execute',...(toolName==='tools'?{name:'connector:private'}:{action_name:'connector:private'}),thought_process:text,args:JSON.stringify({arguments:{body:text}})};
  await handler()({text:'',toolCalls:[{id:'stable',toolName,args}],toolResults:[{toolCallId:'stable',result:{success:true,receipt:{status:'private_result_ready'}}}]});
  expect(writes).toHaveLength(2);expect(writes[1].tool_args).toEqual({action:'call',private_arguments:true,tool_origin:'provider'});
  expect(JSON.stringify(writes)).not.toContain(text);expect(args.thought_process).toBe(text);
});
it('writes only origin, operation and outcome for private discovery and reports while retaining native sibling diagnostics', async () => {
  const secret = randomBytes(24).toString('hex');
  const candidates = {success:true, tools:[{name:`connector:${secret}`, account_label:secret}]};
  const result = {success:false,error:{code:secret,message:secret}};
  const toolCalls = [
    {id:'s',toolName:'tools',args:{action:'search',query:secret,thought_process:secret}},
    {id:'r',toolName:'tools',args:{action:'call',name:`report:${secret}`,args:secret,thought_process:secret}},
    {id:'n',toolName:'tools',args:{action:'call',name:'report',args:'{"action":"list"}'}},
    {id:'o',toolName:'tools',args:{action:'search',tool_origin:secret,query:secret}},
  ];
  await handler()({text:'',toolCalls,toolResults:[
    {toolCallId:'n',result:{success:true,native:'kept'}}, {toolCallId:'r',result,isError:true},
    {toolCallId:'s',result:candidates}, {toolCallId:'o',result},
  ]});
  expect(writes.map(x=>x.log_type)).toEqual(['agent_action','tool_call','tool_call','tool_call','tool_call']);
  expect(writes[1].tool_result).toEqual({success:true,operation_outcome:'passed'});
  expect(writes[2].tool_args).toEqual({action:'call',private_arguments:true,tool_origin:'makinari_report'});
  expect(writes[2].tool_result).toEqual({success:false,operation_outcome:'failed'});
  expect(writes[3].tool_result.output.native).toBe('kept');
  expect(writes[4].tool_args).toEqual({action:'search',private_arguments:true});
  expect(JSON.stringify(writes)).not.toContain(secret);
  expect(JSON.stringify(jest.mocked(console.log).mock.calls)).not.toContain(secret);
  expect(toolCalls[1].args.args).toBe(secret); expect(result.error.message).toBe(secret);
});
