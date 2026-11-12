import { persistCustomerImage } from '../customer-image-persistence';
import { uploadGeneratedImage } from '@/app/api/ai/image/image-storage';
import { supabaseAdmin } from '@/lib/database/supabase-client';
jest.mock('@/app/api/ai/image/image-storage',()=>({uploadGeneratedImage:jest.fn()}));
jest.mock('@/lib/database/supabase-client',()=>({supabaseAdmin:{from:jest.fn()}}));

describe('customer asset acceptance is strict and payer-linked',()=>{
  const insert=jest.fn();
  const input={base64Data:'AA==',siteId:'site',model:'vendor/image',eventId:'receipt',generationId:'generation',
    routing:{payer:'customer' as const,siteId:'site',connectionId:'connection',policyVersion:2,credentialVersion:3}};
  beforeEach(()=>{jest.clearAllMocks();jest.mocked(supabaseAdmin.from).mockReturnValue({insert} as any);
    insert.mockResolvedValue({error:null});
    jest.mocked(uploadGeneratedImage).mockResolvedValue({path:'site/image.png',url:'https://example.test/a.png',size:10,mimeType:'image/png'});});
  it('links durable receipt event and exact payer to persisted asset',async()=>{
    const result=await persistCustomerImage(input);
    expect(result.receipt_event_id).toBe('receipt');
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({site_id:'site',metadata:expect.objectContaining({
      payer:'customer',receipt_event_id:'receipt',connection_id:'connection',policy_version:2,credential_version:3})}));
  });
  it('withholds output on failed asset insert instead of legacy best effort',async()=>{
    insert.mockResolvedValue({error:{message:'failed'}});
    await expect(persistCustomerImage(input)).rejects.toThrow('persistence failed');
  });
  it('rejects cross-site payer before storage',async()=>{
    await expect(persistCustomerImage({...input,siteId:'other'})).rejects.toThrow('Invalid image owner');
    expect(uploadGeneratedImage).not.toHaveBeenCalled();
  });
});