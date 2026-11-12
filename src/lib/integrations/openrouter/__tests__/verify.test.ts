import { randomBytes, randomUUID } from 'node:crypto';
import { quoteImageVerification } from '../image-quote';
import { verifyImage } from '../verify';
import { emptyCapabilities } from '../catalog';
import { encryptCredential } from '../crypto';
import { verifyCustomerImage } from '@/lib/services/ai/customer-verification';
import * as setup from '../setup-store';
import * as store from '../store';
import type { ConnectionRow } from '../types';
jest.mock('@/lib/services/ai/customer-verification', () => ({ verifyCustomerImage: jest.fn() }));
jest.mock('../setup-store', () => ({ claimSetup: jest.fn(), finishSetup: jest.fn() }));
jest.mock('../store', () => ({ publishConnection: jest.fn() }));
const apiKey = randomBytes(32).toString('hex');
const modelId = 'vendor/image';
const input = { operation:'verify' as const, siteId:randomUUID(),expectedRevision:1,operationId:randomUUID(),consent:true as const,maxCostUsd:0.25,capability:'image' as const,modelId };
const endpoint = { provider_tag:'provider/fixed',supported_parameters:{output_format:{type:'enum',values:['png']}},pricing:[{billable:'output_image',unit:'image',cost_usd:0.05}] };
let row:ConnectionRow;
beforeEach(()=>{
  jest.clearAllMocks();process.env.OPENROUTER_CREDENTIAL_ENCRYPTION_KEY=randomBytes(32).toString('base64');
  const id=randomUUID();const capabilities=emptyCapabilities();capabilities.image={mode:'manual',modelId,status:'unavailable',reason:'Verify'};
  row={id,site_id:input.siteId,status:'connected',selected:false,revision:1,policy_version:1,credential_version:1,
    capabilities,catalog:[{id:modelId,name:'Image',inputModalities:['text'],outputModalities:['image'],supportedParameters:[],contextLength:null,endpoints:['/api/v1/images']}],
    encrypted_credential:encryptCredential(apiKey,input.siteId,id,1),catalog_updated_at:null,verified_at:null,updated_at:'',consent_at:null};
  jest.mocked(store.publishConnection).mockImplementation(async(_s,_a,_r,candidate)=>candidate);
  jest.mocked(setup.claimSetup).mockResolvedValue();jest.mocked(setup.finishSetup).mockResolvedValue();
  jest.mocked(verifyCustomerImage).mockResolvedValue({generationId:'generation-test',usage:{cost:0.05},artifactId:randomUUID(),receiptEventId:input.operationId,adapterVersion:'openrouter-images-png-v1',actualModel:modelId});
  jest.spyOn(globalThis,'fetch').mockResolvedValue(Response.json({id:modelId,endpoints:[endpoint]}));
});
afterEach(()=>{jest.restoreAllMocks();delete process.env.OPENROUTER_CREDENTIAL_ENCRYPTION_KEY;});
test('quote requires exact fixed-price PNG endpoint and rejects unknown/token pricing',async()=>{
  await expect(quoteImageVerification(apiKey,modelId,0.25)).resolves.toEqual({providerTag:'provider/fixed',maximumQuotedCostUsd:0.05});
  for(const changed of [{...endpoint,provider_tag:null},{...endpoint,pricing:[{billable:'output_image',unit:'token',cost_usd:0.01}]},
    {...endpoint,pricing:[{billable:'output_image',unit:'image',cost_usd:2}]},{...endpoint,pricing:[]}]){
    jest.mocked(fetch).mockResolvedValueOnce(Response.json({id:modelId,endpoints:[changed]}));
    await expect(quoteImageVerification(apiKey,modelId,0.25)).rejects.toMatchObject({code:'quote_unavailable'});
  }
});
test('claim precedes paid verification and receipt precedes revision-checked publication',async()=>{
  const result=await verifyImage(row,randomUUID(),input);
  expect(setup.claimSetup).toHaveBeenCalledTimes(1);
  expect(jest.mocked(setup.claimSetup).mock.invocationCallOrder[0]).toBeLessThan(jest.mocked(verifyCustomerImage).mock.invocationCallOrder[0]);
  expect(jest.mocked(setup.finishSetup).mock.invocationCallOrder[0]).toBeLessThan(jest.mocked(store.publishConnection).mock.invocationCallOrder[0]);
  expect(verifyCustomerImage).toHaveBeenCalledWith(expect.objectContaining({apiKey,providerTag:'provider/fixed',maximumQuotedCostUsd:0.05,consent:true}));
  expect(result.capabilities.image).toMatchObject({status:'available',verification:{modelId,credentialVersion:1,providerTag:'provider/fixed',operationId:input.operationId}});
  expect(JSON.stringify(jest.mocked(store.publishConnection).mock.calls)).not.toContain(apiKey);
});
test('unknown quote performs no paid call; failed paid request stays uncertain with no publication',async()=>{
  jest.mocked(fetch).mockResolvedValueOnce(Response.json({id:modelId,endpoints:[]}));
  await expect(verifyImage(row,randomUUID(),input)).rejects.toThrow();
  expect(verifyCustomerImage).not.toHaveBeenCalled();expect(setup.claimSetup).not.toHaveBeenCalled();
  jest.mocked(verifyCustomerImage).mockRejectedValueOnce(new Error(apiKey));
  await expect(verifyImage(row,randomUUID(),input)).rejects.toMatchObject({code:'verification_uncertain'});
  expect(verifyCustomerImage).toHaveBeenCalledTimes(1);expect(store.publishConnection).not.toHaveBeenCalled();
  expect(JSON.stringify(jest.mocked(setup.finishSetup).mock.calls)).not.toContain(apiKey);
});