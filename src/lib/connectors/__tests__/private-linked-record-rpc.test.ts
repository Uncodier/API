import { randomUUID } from 'node:crypto';
import { loadOwnerAskRecords, loadOwnerConnectorFollowup, publishOwnerConnectorAnswer } from '@/lib/services/robot-instance/owner-connector-answer';

const mockRpc = jest.fn();
jest.mock('@/lib/database/supabase-client', () => ({supabaseAdmin:{rpc:(...args:unknown[]) => mockRpc(...args)}}));
const scope = {siteId:randomUUID(),instanceId:randomUUID(),userId:randomUUID(),userMessageLogId:randomUUID()};
const ids = [randomUUID(),randomUUID()];
const rows = ids.map((id,i) => ({id,title:`Period ${i}`,description:`Private ${randomUUID()}`,data:{Period:`Q${i + 1}`,total:i},updated_at:null}));
function respond(data: unknown, error:unknown = null) { mockRpc.mockReturnValue({abortSignal:async () => ({data,error})}); }
beforeEach(() => mockRpc.mockReset());

it('loads the entire bounded projection (including zero) from the action-authorized RPC only', async () => {
  respond([...rows].reverse());
  await expect(loadOwnerAskRecords(scope,ids)).resolves.toEqual(rows);
  expect(mockRpc.mock.calls).toEqual([['read_ask_linked_records',{p_action_id:scope.userMessageLogId,p_record_ids:ids}]]);
});

it.each(['denied','partial','foreign','duplicate','unexpected field','missing data','oversized'])('rejects %s reads without fallback', async kind => {
  if (kind === 'denied') respond(rows,{code:'42501'});
  if (kind === 'partial') respond(rows.slice(0,1));
  if (kind === 'foreign') respond([rows[0],{...rows[1],id:randomUUID()}]);
  if (kind === 'duplicate') respond([rows[0],rows[0]]);
  if (kind === 'unexpected field') respond([{...rows[0],extra:'not projected'},rows[1]]);
  if (kind === 'missing data') { const {data,...rest} = rows[0]; respond([rest,rows[1]]); }
  if (kind === 'oversized') respond([{...rows[0],description:'x'.repeat(131072)},rows[1]]);
  await expect(loadOwnerAskRecords(scope,ids)).rejects.toMatchObject({code:'private_context_unavailable'});
  expect(mockRpc).toHaveBeenCalledTimes(1);
});

it.each([false,true])('accepts a protected parent and passes all authority to publication (mixed=%s)', async mixed => {
  const connectors = mixed ? [randomUUID()] : [];
  const source = randomUUID(), parent = {source_id:source,answer:'Old evidence',tool_context:[],record_ids:ids,connector_ids:connectors};
  respond(parent);
  await expect(loadOwnerConnectorFollowup(scope)).resolves.toEqual(parent);
  respond(true);
  const claim = randomUUID(), entries = [{claim_id:claim,result:{value:5}}];
  const actual = await publishOwnerConnectorAnswer(scope,[claim],'0 then 1',entries,source,ids);
  expect(actual).toBe(`This answer uses private workspace data. [Open your answer](/robots/private-answer/${scope.userMessageLogId}).`);
  const [name,args] = mockRpc.mock.calls[1];
  expect(name).toBe('store_linked_record_ask_turn');
  expect(args).toMatchObject({p_record_ids:ids,p_action_id:scope.userMessageLogId,p_source_id:source,p_claim_ids:[claim],p_tool_context:entries});
  for (const row of rows) {
    expect(args.p_answer).toContain(`[Record ${row.id}](/records/${row.id})`);
    expect(actual).not.toContain(row.id);
    expect(JSON.stringify(args)).not.toContain(row.description);
  }
  respond(false);
  await expect(publishOwnerConnectorAnswer(scope,[],'Summary',[],source,ids)).rejects.toMatchObject({code:'conflict'});
  expect(mockRpc).toHaveBeenCalledTimes(3);
});
