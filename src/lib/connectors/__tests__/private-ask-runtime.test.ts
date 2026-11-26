import { randomBytes, randomUUID } from 'node:crypto';
import { loadOwnerConnectorFollowup, publishOwnerConnectorAnswer } from '@/lib/services/robot-instance/owner-connector-answer';
import { ownerConnectorTranscript } from '@/lib/services/robot-instance/owner-connector-transcript';

const mockRpc = jest.fn();
jest.mock('@/lib/database/supabase-client', () => ({supabaseAdmin:{rpc:(...args:unknown[]) => mockRpc(...args)}}));
const scope = {siteId:randomUUID(),instanceId:randomUUID(),userId:randomUUID(),userMessageLogId:randomUUID()};
const respond = (data: unknown, error: unknown = null) => mockRpc.mockReturnValue({abortSignal:async () => ({data,error})});
beforeEach(() => mockRpc.mockReset());

it.each(['missing RPC','legacy shape','wrong destination','malformed entry','oversized entry'])('refuses unsafe history instead of falling back: %s', async reason => {
  const base = {source_id:randomUUID(),answer:'Historical data'};
  const data = {...base,connector_ids:[randomUUID()],tool_context:[{claim_id:randomUUID(),result:{value:1}}]};
  if (reason === 'missing RPC') respond(null,{code:'PGRST202'});
  else if (reason === 'legacy shape') respond(base);
  else if (reason === 'wrong destination') respond({...data,connector_ids:[]});
  else if (reason === 'malformed entry') respond({...data,tool_context:[{claim_id:randomUUID()}]});
  else respond({...data,tool_context:[{claim_id:randomUUID(),result:'x'.repeat(131072)}]});
  await expect(loadOwnerConnectorFollowup(scope)).rejects.toMatchObject({code:'private_context_unavailable'});
  expect(mockRpc.mock.calls).toEqual([['connector_ask_context',{p_action_id:scope.userMessageLogId}]]);
});

it('retries only the same context read after a transient gateway failure', async () => {
  mockRpc.mockReturnValueOnce({abortSignal:async () => ({status:503,error:{code:'unavailable'}})});
  respond(null);
  await expect(loadOwnerConnectorFollowup(scope)).resolves.toBeUndefined();
  expect(mockRpc.mock.calls).toEqual(Array(2).fill(['connector_ask_context',{p_action_id:scope.userMessageLogId}]));
});

it.each([[503,2],[403,1]])('bounds retries on HTTP %i and does not downgrade the connector policy', async (status, calls) => {
  mockRpc.mockReturnValue({abortSignal:async () => ({status,error:{code:'unavailable'}})});
  await expect(loadOwnerConnectorFollowup(scope)).rejects.toMatchObject({code:'private_context_unavailable'});
  expect(mockRpc).toHaveBeenCalledTimes(calls);
});

it('passes only fresh claims + projected entries and exact prior authority to the combined write', async () => {
  const source = randomUUID(), claim = randomUUID(), entries = [{claim_id:claim,result:{value:'42.01'}}];
  const token = randomBytes(24).toString('hex');
  respond(true);
  expect(await publishOwnerConnectorAnswer(scope,[claim],`42.01 (Bearer ${token})`,entries,source)).toContain(`/robots/private-answer/${scope.userMessageLogId}`);
  const [rpc,args] = mockRpc.mock.calls[0];
  expect(rpc).toBe('store_connector_ask_turn');
  expect(args).toMatchObject({p_action_id:scope.userMessageLogId,p_claim_ids:[claim],p_tool_context:entries,p_source_id:source});
  expect(JSON.stringify(args)).not.toContain(token);
  respond(false);
  await expect(publishOwnerConnectorAnswer(scope,[claim],'42.01',entries,source)).rejects.toMatchObject({code:'conflict'});
});

it('bounds historical values without dropping omitted or older contributing claims', () => {
  const claims = Array.from({length:14}, () => randomUUID()), connector = randomUUID();
  const messages = claims.map((claim,i) => ({role:'tool',content:JSON.stringify({success:true,result_visibility:'ask_owner',
    result_claim_id:claim,result_connector_id:connector, ...(i === 13 ? {result_omitted:true} : {result:'x'.repeat(16000)}),
    diagnostics:'DO_NOT_STORE',arguments:{data:'DO_NOT_STORE'}})}));
  const ctx = ownerConnectorTranscript(messages)!;
  expect(ctx.claimIds).toEqual(claims);
  expect(ctx.toolContext.length).toBeLessThanOrEqual(8);
  expect(Buffer.byteLength(JSON.stringify(ctx.toolContext))).toBeLessThanOrEqual(65536);
  expect(ctx.toolContext.at(-1)).toEqual({claim_id:claims[13],result:{omitted:true}});
  expect(JSON.stringify(ctx.toolContext)).not.toContain('DO_NOT_STORE');
});
