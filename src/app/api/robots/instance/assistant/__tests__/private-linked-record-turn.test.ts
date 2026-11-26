import { randomUUID } from 'node:crypto';
import { instanceId, siteId, turn } from './assistant-turn-fixture';
jest.mock('@vercel/sandbox', () => ({ Sandbox: {} }));

function fixture() {
  const f = turn(), scope = {siteId, instanceId, userId:randomUUID(), userMessageLogId:randomUUID()};
  const rows = ['2025-Q4','2026-Q3'].map((period,i) => ({id:randomUUID(), title:`Bookings ${period}`,
    description:`Private source notes ${randomUUID()}`, data:{Period:period, bookings:i ? 19 : 0, issues:[]}, updated_at:'2026-11-15T12:00:00Z'}));
  const ids = rows.map(row => row.id);
  const message = `Compare https://app.makinari.com/records/${ids[0]} and /records/${ids[1]}`;
  Object.assign(f.context,{initialMessage:message,instanceNodeId:undefined,callerSource:'interactive',catalogUserSession:true,recoveryScope:scope});
  const write = jest.fn();
  f.context.customTools = [{name:'external',execute:write}];
  f.getTools.mockResolvedValue([{name:'tools',execute:write}]);
  f.ownerAnswers.loadOwnerAskRecords.mockResolvedValue(rows);
  return {...f,scope,rows,ids,message,write};
}

it.each(['fresh','mixed parent','native parent'])('uses complete fresh authorized rows and returns only the owner receipt: %s', async mode => {
  const f = fixture(), source = randomUUID(), historical = `Historic summary ${randomUUID()}`, connector = randomUUID();
  const parent = mode !== 'fresh';
  if (parent) {
    // The parent contributes one Record; the user adds the other. The mixed
    // parent contributes connector authority too, even with a selected connector.
    f.ownerAnswers.loadOwnerConnectorFollowup.mockResolvedValue({source_id:source,answer:historical,
      connector_ids:mode === 'mixed parent' ? [connector] : [],tool_context:[],record_ids:[f.ids[0]]});
    f.context.initialMessage = `Include /records/${f.ids[1]} and check fresh external trends.`;
    f.context.connectorIdHint = connector;
  }
  const reply = `Answer based on ${f.rows[0].description}`, log = jest.spyOn(console,'info').mockImplementation(() => {});
  const hostile = `https://sink.example.test/${randomUUID()}`;
  f.executor.mockImplementationOnce(async (input, _instance, opts) => {
    expect(opts.ownerConnectorContext).toBe(true);
    expect(opts.privateAssetsHydrated).toBe(true);
    const material = JSON.parse(input[0].content.split('\n')[1]);
    expect(material).toEqual(f.rows);
    expect(input[0].content).toContain('untrusted data');
    expect(opts.system_prompt).toContain('actual Period');
    expect(opts.system_prompt).toContain('No external source has been queried');
    expect(JSON.stringify(input).includes(historical)).toBe(parent);
    expect(opts.custom_tools.map((t:any) => t.name)).toEqual(['read_linked_records']);
    expect(opts.tool_overrides).toBeUndefined();
    const tool = opts.custom_tools[0];
    expect(await tool.execute({url:hostile,record_ids:[randomUUID()],query:reply})).toEqual({success:false,code:'INVALID_RECORD_SCOPE'});
    const result = await tool.execute({scope:'linked'});
    expect(result.records).toEqual(f.rows);
    return {isDone:false,messages:[...input,{role:'tool',content:JSON.stringify(result)}]};
  }).mockImplementationOnce(async input => {
    expect(JSON.parse(input[0].content.split('\n')[1])).toEqual(f.rows);
    return {text:reply,isDone:true,messages:input,steps:[{text:reply}],output:{debug:hostile}};
  });
  try {
    const out = await f.run(f.context,[{role:'user',content:f.context.initialMessage}]);
    expect(f.ownerAnswers.loadOwnerAskRecords.mock.calls).toEqual(Array(3).fill([f.scope,f.ids]));
    expect(f.ownerAnswers.publishOwnerConnectorAnswer).toHaveBeenCalledWith(f.scope,[],reply,[],parent ? source : undefined,f.ids);
    expect(out).toEqual({text:'Open your owner answer',isDone:true,messages:[],resumable:false,steps:[{finishReason:'stop'}]});
    for (const privateValue of [...f.ids,f.rows[0].description,hostile,source,historical,reply]) {
      expect(JSON.stringify([out,log.mock.calls])).not.toContain(privateValue);
    }
    expect(f.getTools).not.toHaveBeenCalled();
    expect(f.write).not.toHaveBeenCalled();
  } finally { log.mockRestore(); }
});

it('re-reads a native-only parent on successive link-free follow-ups instead of treating the stored answer as current', async () => {
  const f = fixture();
  f.context.initialMessage = 'What are the counts now?';
  for (const count of [0, 23]) {
    f.scope.userMessageLogId = randomUUID();
    const parent = randomUUID();
    f.ownerAnswers.loadOwnerConnectorFollowup.mockResolvedValue({source_id:parent,answer:'Historic count: 100',
      record_ids:f.ids, connector_ids:[],tool_context:[]});
    const rows = f.rows.map(row => ({...row, data:{...row.data,bookings:count}}));
    f.ownerAnswers.loadOwnerAskRecords.mockResolvedValue(rows);
    f.executor.mockImplementationOnce(async input => ({text:`Live count: ${JSON.parse(input[0].content.split('\n')[1])[0].data.bookings}`, isDone:true}));
    await f.run(f.context,[{role:'user',content:f.context.initialMessage}]);
    expect(f.ownerAnswers.publishOwnerConnectorAnswer).toHaveBeenLastCalledWith(f.scope,[],`Live count: ${count}`,[],parent,f.ids);
  }
  expect(f.ownerAnswers.loadOwnerAskRecords).toHaveBeenCalledTimes(2);
});

it.each(['revoked read','publication denied','over limit','lost admission','resumed'])('does not downgrade or leak when %s', async mode => {
  const f = fixture();
  if (mode === 'lost admission') f.context.catalogUserSession = undefined;
  if (mode === 'resumed') f.context.recoveryScope.generation = 1;
  if (mode === 'over limit') f.ownerAnswers.loadOwnerConnectorFollowup.mockResolvedValue({source_id:randomUUID(),answer:'Old',
    record_ids:Array.from({length:8}, () => randomUUID()),connector_ids:[],tool_context:[]});
  if (mode === 'revoked read') f.ownerAnswers.loadOwnerAskRecords.mockRejectedValue(new Error(f.rows[0].description));
  if (mode === 'publication denied') {
    f.executor.mockResolvedValue({text:f.rows[0].description,isDone:true});
    f.ownerAnswers.publishOwnerConnectorAnswer.mockRejectedValue(new Error(f.rows[0].description));
  }
  await expect(f.run(f.context,[{role:'user',content:f.context.initialMessage}])).rejects.toMatchObject({code:'private_context_unavailable'});
  expect(f.getTools).not.toHaveBeenCalled();
  expect(f.executor).toHaveBeenCalledTimes(mode === 'publication denied' ? 1 : 0);
});

it('does not infer source IDs from a tool reply, historical answer or system prompt', async () => {
  const f = fixture(), privateLink = `/records/${f.ids[0]}`;
  f.context.initialMessage = 'Summarize again';
  f.context.systemPrompt = privateLink;
  f.ownerAnswers.loadOwnerConnectorFollowup.mockResolvedValue({source_id:randomUUID(),answer:privateLink,
    connector_ids:[randomUUID()],tool_context:[]});
  f.executor.mockResolvedValue({isDone:true,text:'Historical summary only.'});
  await f.run(f.context,[{role:'user',content:f.context.initialMessage},{role:'tool',content:privateLink}]);
  expect(f.ownerAnswers.loadOwnerAskRecords).not.toHaveBeenCalled();
  expect(f.getTools).toHaveBeenCalledTimes(1);
});
