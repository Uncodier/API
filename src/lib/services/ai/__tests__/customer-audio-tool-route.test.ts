import { randomBytes,randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import { generateAudioTool } from '@/app/api/agents/tools/generateAudio/assistantProtocol';
import { POST } from '@/app/api/ai/audio/route';
import { withExecutionRouting,withCustomerOperation } from '../customer-routing';
import { resolveCustomerCredential } from '@/lib/integrations/openrouter/store';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { CreditService } from '../../billing/CreditService';
jest.mock('@/lib/integrations/openrouter/store',()=>({resolveCustomerCredential:jest.fn()}));
jest.mock('@/lib/security/site-access',()=>({canAccessSite:jest.fn(async()=>true)}));
jest.mock('@/lib/security/request-rate-limit',()=>({enforceRequestRateLimit:jest.fn(async()=>null),getAuthenticatedRateIdentity:()=> 'internal',isInternalServiceRequest:()=>true}));
jest.mock('@/lib/services/billing/CreditService',()=>({CreditService:{validateCredits:jest.fn(),deductCredits:jest.fn(),PRICING:{AUDIO_GENERATION_MINUTE:1}}}));
jest.mock('@/lib/database/supabase-client',()=>({supabaseAdmin:{rpc:jest.fn(),storage:{from:jest.fn().mockReturnThis(),upload:jest.fn(async()=>({error:null})),getPublicUrl:()=>({data:{publicUrl:'https://example.invalid/audio.mp3'}})}}}));
jest.mock('@/lib/tools/instance-log-core',()=>({createInstanceLogCore:jest.fn()}));
const original=process.env;
const siteId=randomUUID(),key=randomBytes(32).toString('hex');
const routing={payer:'customer' as const,siteId,connectionId:randomUUID(),policyVersion:1,credentialVersion:1};
beforeEach(()=>{
  jest.clearAllMocks();process.env={NODE_ENV:'test',SERVICE_API_KEY:randomBytes(32).toString('hex'),NEXT_PUBLIC_API_SERVER_URL:'https://example.invalid'};
  jest.mocked(resolveCustomerCredential).mockResolvedValue({apiKey:key,capabilities:{speech:{mode:'manual',modelId:'vendor/speech',status:'unverified',reason:'Test'}},catalog:[{id:'vendor/speech',contextLength:8192}]} as never);
  jest.mocked(supabaseAdmin.rpc).mockImplementation((async(name:string,args:any)=>({data:name==='openrouter_customer_dispatch'?{claimed:true,event_id:args.p_intent.event_id}:null,error:null})) as never);
});
afterEach(()=>{process.env=original;jest.restoreAllMocks();});
test('real tool request satisfies real route idempotency and spends only the customer key',async()=>{
  let internalHeaders:Headers|undefined;
  const mp3=Buffer.alloc(417);mp3.set([0xff,0xfb,0x90,0x00]);
  const fetcher=jest.spyOn(globalThis,'fetch').mockImplementation(async(url,init)=>{
    if(String(url)==='https://example.invalid/api/ai/audio'){
      internalHeaders=new Headers(init?.headers);
      return POST(new NextRequest(String(url),init as any));
    }
    expect(String(url)).toBe('https://openrouter.ai/api/v1/audio/speech');
    expect(new Headers(init?.headers).get('Authorization')).toBe(`Bearer ${key}`);
    return new Response(mp3,{headers:{'content-type':'audio/mpeg','x-generation-id':'generation-test'}});
  });
  const result=await withExecutionRouting(routing,siteId,()=>withCustomerOperation('long-host-operation-'.repeat(12),()=>generateAudioTool(siteId).execute({text:'Hello'})));
  expect(result).toMatchObject({success:true,provider:'openrouter'});
  expect(fetcher).toHaveBeenCalledTimes(2);
  const id=internalHeaders!.get('Idempotency-Key');expect(id).toMatch(/^speech:[a-f0-9]{64}$/);
  const ticket=JSON.parse(Buffer.from(internalHeaders!.get('x-host-inference-routing')!.split('.')[0],'base64url').toString());
  expect(ticket.operationId).toBe(id);
  expect(jest.mocked(supabaseAdmin.rpc).mock.calls[0][1]).toMatchObject({p_intent:{operation_key:id}});
  expect(CreditService.validateCredits).not.toHaveBeenCalled();expect(CreditService.deductCredits).not.toHaveBeenCalled();
});