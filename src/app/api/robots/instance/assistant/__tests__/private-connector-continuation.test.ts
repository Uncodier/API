import { randomUUID } from 'node:crypto';
import { turn, instanceId, siteId } from './assistant-turn-fixture';
jest.mock('@vercel/sandbox', () => ({ Sandbox: {} }));

describe('private connector continuations', () => {
  it('lets the next model step analyze the live result but publishes only the owner answer link', async () => {
    const f = turn(), connector = randomUUID(), claim = randomUUID(), actionId = randomUUID();
    const scope = {siteId,instanceId,userId:randomUUID(),userMessageLogId:actionId};
    Object.assign(f.context,{instanceNodeId:undefined,callerSource:'interactive',catalogUserSession:true,recoveryScope:scope,conversationRecoveryOnly:undefined});
    const privateText = `Verified ${randomUUID()}`;
    const record = `/connectors/results/${randomUUID()}`;
    const messages = [{role:'user',content:'My quarterly KPIs'},
      {role:'assistant',tool_calls:[{id:'sql',function:{name:'tools',arguments:'{}'}}]},
      {role:'tool',tool_call_id:'sql',content:JSON.stringify({success:true,result_visibility:'ask_owner',result_connector_id:connector,
        result_claim_id:claim,result:{label:privateText},receipt:{status:'private_result_ready',url:record}})}];
    const execute = jest.fn(async (_args:unknown) => ({success:true}));
    f.getTools.mockResolvedValue([{name:'tools',execute},{name:'send',execute}]);
    f.executor.mockImplementationOnce(async (input,_instance,options) => {
      expect(JSON.stringify(input)).toContain(privateText);
      expect(options.ownerConnectorContext).toBe(true);
      expect(options.custom_tools.map((tool:{name:string}) => tool.name)).toEqual(['tools']);
      expect(await options.custom_tools[0].execute({action:'call',name:`connector:${randomUUID()}:APP_SEND`,args:'{}'}))
        .toMatchObject({success:false,executed:false,code:'PRIVATE_CONNECTOR_DESTINATION_REQUIRED'});
      return {messages:[...input,{role:'assistant',content:privateText}],text:privateText,isDone:true,
        output:{text:privateText},steps:[{text:privateText,finishReason:'stop'}]};
    });
    const out = await f.run(f.context,messages);
    expect(f.ownerAnswers.confirmOwnerConnectorContext).toHaveBeenCalledWith([claim]);
    expect(f.ownerAnswers.publishOwnerConnectorAnswer).toHaveBeenCalledWith(scope,[claim],`${privateText}\n\n[Open saved connector result](${record})`,[{claim_id:claim,result:{value:{label:privateText}}}],undefined);
    expect(out).toMatchObject({text:'Open your owner answer',isDone:true,steps:[{finishReason:'stop'}]});
    expect(JSON.stringify(out)).not.toContain(privateText);
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([true, false])('keeps saved private context and derived text inside the private boundary (access=%s)', async allowed => {
    const f = turn(), source = randomUUID(), text = `Private data ${randomUUID()}`;
    const scope = {siteId,instanceId,userId:randomUUID(),userMessageLogId:randomUUID()};
    Object.assign(f.context,{instanceNodeId:undefined,callerSource:'interactive',catalogUserSession:true,recoveryScope:scope});
    const messages = [{role:'user',content:'Explain those KPIs'}];
    f.ownerAnswers.loadOwnerConnectorFollowup.mockResolvedValue(allowed ? {source_id:source,answer:text,tool_context:[],connector_ids:[randomUUID()]} : {unavailable:true});
    f.executor.mockImplementationOnce(async (input,_instance,options) => {
      expect(JSON.stringify(input).includes(text)).toBe(allowed);
      expect(options.ownerConnectorContext).toBe(allowed ? true : undefined);
      expect(options.custom_tools).toEqual([]);
      const reply = allowed ? text : 'Previous answer is unavailable.';
      return {messages:[...input,{role:'assistant',content:reply}],text:reply,isDone:true,output:{reply},steps:[{text:reply,finishReason:'stop'}]};
    });
    const out = await f.run(f.context,messages);
    expect(f.getTools).toHaveBeenCalledTimes(allowed ? 1 : 0);
    if (allowed) expect(f.ownerAnswers.publishOwnerConnectorAnswer).toHaveBeenCalledWith(scope,[],text,[],source);
    else expect(f.ownerAnswers.publishOwnerConnectorAnswer).not.toHaveBeenCalled();
    expect(JSON.stringify(out)).not.toContain(text);
    expect(out.text).toBe(allowed ? 'Open your owner answer' : 'Previous answer is unavailable.');
  });
  it('discards an incomplete private answer without persisting or replaying it', async () => {
    const f = turn(), text = `Private data ${randomUUID()}`;
    const scope = {siteId,instanceId,userId:randomUUID(),userMessageLogId:randomUUID()};
    Object.assign(f.context,{instanceNodeId:undefined,callerSource:'interactive',catalogUserSession:true,recoveryScope:scope});
    const messages = [{role:'user',content:'Summarize the comparison'}];
    f.ownerAnswers.loadOwnerConnectorFollowup.mockResolvedValue({source_id:randomUUID(),answer:text,tool_context:[],connector_ids:[randomUUID()]});
    f.executor.mockImplementationOnce(async input => ({messages:[...input,{role:'assistant',content:text}],
      text,isDone:false,steps:[{text,finishReason:'length'}]}));
    expect(await f.run(f.context,messages)).toEqual({text:'',isDone:false,resumable:false,executionStatus:'exhausted',messages,steps:[{finishReason:'length'}]});
  });
});

it.each(['ok','revoked after dispatch','malformed receipt','publication denied'] as const)(
  'keeps old and fresh results private and fails closed: %s', async mode => {
    const f = turn(), connector = randomUUID(), claim = randomUUID(), source = randomUUID();
    const oldValue = randomUUID(), freshValue = randomUUID();
    const scope = {siteId,instanceId,userId:randomUUID(),userMessageLogId:randomUUID()};
    Object.assign(f.context,{instanceNodeId:undefined,callerSource:'interactive',catalogUserSession:true,recoveryScope:scope});
    const prior = {source_id:source,answer:'Historical report',tool_context:[{claim_id:randomUUID(),result:{value:oldValue}}],connector_ids:[connector]};
    f.ownerAnswers.loadOwnerConnectorFollowup.mockResolvedValue(prior);
    if (mode === 'publication denied') f.ownerAnswers.publishOwnerConnectorAnswer.mockRejectedValue(new Error(freshValue));
    const execute = jest.fn(async () => ({success:true,result_visibility:'ask_owner',result_connector_id:connector,
      result_claim_id: mode === 'malformed receipt' ? '' : claim,result:freshValue,result_truncated:true}));
    f.getTools.mockResolvedValue([{name:'tools',execute},{name:'shared_file',execute}]);
    f.executor.mockImplementationOnce(async (input,_instance,opts) => {
      expect(opts.ownerConnectorContext).toBe(true);
      expect(JSON.stringify(input)).toContain(oldValue);
      expect(opts.custom_tools.map((t:any) => t.name)).toEqual(['tools']);
      const call = {action:'call',name:`connector:${connector}:SUPABASE_RUN_READ_ONLY_QUERY`,args:JSON.stringify({arguments:{query:'SELECT 1'}})};
      for (const forbidden of [{...call,name:'sendEmail'}, {...call,args:JSON.stringify({save_record:true})},
        {...call,connector_id:randomUUID()}, {action:'search',query:oldValue}]) {
        expect(await opts.custom_tools[0].execute(forbidden)).toMatchObject({executed:false});
      }
      const data = await opts.custom_tools[0].execute(call);
      if (mode === 'revoked after dispatch') f.ownerAnswers.loadOwnerConnectorFollowup.mockResolvedValue({unavailable:true});
      return {isDone:false,text:'',messages:[...input,{role:'tool',content:JSON.stringify(data)}]};
    }).mockImplementationOnce(async input => {
      expect(JSON.stringify(input)).toContain(freshValue);
      return {isDone:true,text:`${oldValue} vs ${freshValue}`,messages:[],output:{leak:freshValue},steps:[{text:oldValue,finishReason:'stop'}]};
    });
    const messages = [{role:'user',content:'Refresh and compare the figures.'}];
    const op = f.run(f.context,messages);
    if (mode !== 'ok') {
      await expect(op).rejects.toMatchObject({name:'RecoveryError',code:'private_context_unavailable'});
      if (mode !== 'publication denied') expect(f.ownerAnswers.publishOwnerConnectorAnswer).not.toHaveBeenCalled();
    } else {
      const out = await op;
      expect(f.getTools.mock.calls[0][14]).toBe(connector);
      expect(f.getTools.mock.calls[0][18]).toEqual(expect.any(Function));
      expect(f.ownerAnswers.confirmOwnerConnectorContext).toHaveBeenCalledWith([claim]);
      expect(f.ownerAnswers.publishOwnerConnectorAnswer).toHaveBeenCalledWith(scope,[claim],`${oldValue} vs ${freshValue}`,
        [{claim_id:claim,result:{value:freshValue,truncated:true}}],source);
      expect(out.text).toBe('Open your owner answer');
      for (const hidden of [oldValue,freshValue,claim,source,connector]) expect(JSON.stringify(out)).not.toContain(hidden);
    }
    expect(execute).toHaveBeenCalledTimes(1);
  });

it.each(['multi-source','different selection'])('does not dispatch into an ambiguous private destination: %s', async kind => {
  const f = turn(), connector = randomUUID(), other = randomUUID();
  const scope = {siteId,instanceId,userId:randomUUID(),userMessageLogId:randomUUID()};
  Object.assign(f.context,{instanceNodeId:undefined,callerSource:'interactive',catalogUserSession:true,recoveryScope:scope,
    ...(kind === 'different selection' && {connectorIdHint:other})});
  f.ownerAnswers.loadOwnerConnectorFollowup.mockResolvedValue({source_id:randomUUID(),answer:'Authorized comparison',
    connector_ids:kind === 'multi-source' ? [connector,other] : [connector],tool_context:[]});
  f.executor.mockImplementationOnce(async (_input,_instance,opts) => {
    expect(opts.ownerConnectorContext).toBe(true); expect(opts.custom_tools).toEqual([]);
    return {text:'Historical comparison only',isDone:true,messages:[]};
  });
  expect((await f.run(f.context,[{role:'user',content:'Compare again'}])).text).toBe('Open your owner answer');
  expect(f.getTools).not.toHaveBeenCalled();
});
