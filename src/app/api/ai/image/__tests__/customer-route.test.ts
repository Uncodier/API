import { NextRequest } from 'next/server';
import { POST } from '../route';
import { generateWithAzure } from '../provider-azure';
import { generateCustomerImageArtifacts } from '@/lib/services/ai/customer-images';
import { holdImageCredits, settleImageCredits } from '@/lib/services/billing/image-credit-reservations';
import { canAccessSite } from '@/lib/security/site-access';

jest.mock('@/lib/security/request-rate-limit', () => ({ enforceRequestRateLimit: jest.fn(async()=>null),
  getAuthenticatedRateIdentity: jest.fn(()=> 'user:test'), isInternalServiceRequest: jest.fn(()=>false) }));
jest.mock('@/lib/security/site-access', () => ({ canAccessSite: jest.fn(async()=>true) }));
jest.mock('@/lib/services/ai/media-instance-access',()=>({mediaInstanceBelongsToSite:jest.fn(async()=>true)}));
jest.mock('@/lib/services/ai/customer-routing-http',()=>({withHttpExecutionRouting:jest.fn(async(_r,_s,operation)=>operation()),resolveHttpExecutionRouting:jest.fn(async(_r,siteId)=>({
  payer:'customer',siteId,connectionId:'connection',policyVersion:1,credentialVersion:1}))}));
jest.mock('@/lib/integrations/openrouter/store',()=>({resolveCustomerCredential:jest.fn(async()=>({}))}));
jest.mock('@/lib/services/ai/customer-images',()=>({generateCustomerImageArtifacts:jest.fn()}));
jest.mock('../provider-azure',()=>({generateWithAzure:jest.fn(),validateAzureImageOptions:jest.fn()}));
jest.mock('@/lib/services/billing/image-credit-reservations',()=>({holdImageCredits:jest.fn(),settleImageCredits:jest.fn(),
  ImageReservationError:class extends Error{}}));
const site='11111111-1111-4111-8111-111111111111';
const request=(body:object={},key='operation-1')=>new NextRequest('http://localhost/api/ai/image',{
  method:'POST',headers:key?{'Idempotency-Key':key}:{},body:JSON.stringify({site_id:site,prompt:'a circle',...body})});

describe('customer image route payer and persistence integration',()=>{
  beforeEach(()=>{jest.clearAllMocks();jest.mocked(canAccessSite).mockResolvedValue(true);
    jest.mocked(generateCustomerImageArtifacts).mockResolvedValue({images:[{url:'https://example.test/image.png',b64_json:null,
      artifact_id:'asset',receipt_event_id:'receipt'}],model:'vendor/image',usage:{cost:0.01},generationId:'generation',receiptEventId:'receipt'});});
  it('uses authorized selection, stable claim and required persistence, not platform balances',async()=>{
    const response=await POST(request());expect(response.status).toBe(200);
    expect(generateCustomerImageArtifacts).toHaveBeenCalledWith(expect.objectContaining({siteId:site,persist:true,operationKey:'image:operation-1'}));
    expect(await response.json()).toMatchObject({provider:'openrouter',metadata:{payer:'customer',receipt_event_id:'receipt'}});
    expect(generateWithAzure).not.toHaveBeenCalled();expect(holdImageCredits).not.toHaveBeenCalled();expect(settleImageCredits).not.toHaveBeenCalled();
  });
  it('denies foreign site before customer adapter or privileged persistence',async()=>{
    jest.mocked(canAccessSite).mockResolvedValue(false);expect((await POST(request())).status).toBe(403);
    expect(generateCustomerImageArtifacts).not.toHaveBeenCalled();
  });
  it('requires durable operation identity',async()=>{
    expect((await POST(request({},''))).status).toBe(400);expect(generateCustomerImageArtifacts).not.toHaveBeenCalled();
  });
  it('does not accept client payer flags or fallback after failed customer persistence',async()=>{
    jest.mocked(generateCustomerImageArtifacts).mockRejectedValue(new Error('storage failed'));
    expect((await POST(request({payer:'platform',skip_billing:true}))).status).toBe(500);
    expect(generateWithAzure).not.toHaveBeenCalled();expect(settleImageCredits).not.toHaveBeenCalled();
  });
});