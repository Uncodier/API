import { combinedChatPolicyIssue,supportsChatContract } from '../chat-contract';
import { emptyCapabilities,evaluateCapabilities } from '../catalog';
import { selectorRequest } from '../selector';
import type {CatalogModel,ConnectionRow} from '../types';
const model=(id:string,params:string[],images=false):CatalogModel=>({id,name:id,inputModalities:images?['text','image']:['text'],outputModalities:['text'],supportedParameters:params,contextLength:128000,pricing:{prompt:0.000001,completion:0.000002}});
const tools=model('vendor/tools',['tools','structured_outputs']);
const structured=model('vendor/structured',['structured_outputs']);
test('different valid independent models support a combined request without requiring identical pins',()=>{
  const policies=emptyCapabilities();
  policies.tools={mode:'manual',modelId:tools.id,status:'unverified',reason:''};
  policies.structured={mode:'manual',modelId:structured.id,status:'unverified',reason:''};
  expect(combinedChatPolicyIssue(policies,[tools,structured])).toBeNull();
  expect(supportsChatContract(tools,['tools','structured'])).toBe(true);
});
test('configuration rejects a primary model unable to satisfy enabled secondary capabilities',()=>{
  const policies=emptyCapabilities();policies.tools={mode:'manual',modelId:tools.id,status:'unverified',reason:''};policies.structured={mode:'manual',modelId:structured.id,status:'unverified',reason:''};
  expect(combinedChatPolicyIssue(policies,[{...tools,supportedParameters:['tools']},structured])).toContain('tools model must also support');
  policies.structured.mode='disabled';expect(combinedChatPolicyIssue(policies,[{...tools,supportedParameters:['tools']},structured])).toBeNull();
});
test('selector filters tools/vision shortlist to models capable of combined requests',()=>{
  const catalog=[tools,structured,model('vendor/tools-only',['tools']),model('vendor/vision-only',[],true),model('vendor/vision-all',['tools','structured_outputs'],true)];
  const row={credential_version:1,catalog,capabilities:emptyCapabilities()} as ConnectionRow;
  const request=selectorRequest(row,{maxPromptPrice:5,maxCompletionPrice:20},1);
  expect(request.candidates.tools?.map(item=>item.id)).not.toContain('vendor/tools-only');
  expect(request.candidates.vision?.map(item=>item.id)).toEqual(['vendor/vision-all']);
  expect(evaluateCapabilities(row.capabilities,catalog).tools.mode).toBe('disabled');
});