import { NextRequest } from 'next/server';
import { randomUUID } from 'node:crypto';
import { POST } from '../route';
import { supabaseAdmin } from '@/lib/database/supabase-client';
jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: {from:jest.fn()} }));
jest.mock('@/lib/services/team-notification-service', () => ({TeamNotificationService:{}}));
const lead = randomUUID(), conversation = randomUUID(), site = randomUUID();
it.each([null, {channel:'internal_review',lead_id:lead,site_id:site}, {channel:'web',lead_id:randomUUID(),site_id:site}])('never sends a review or unrelated conversation link through the inbound notification fallback', async data => {
  const q = {select:jest.fn().mockReturnThis(),eq:jest.fn().mockReturnThis(),maybeSingle:jest.fn().mockResolvedValue({data,error:null})};
  const from = jest.mocked(supabaseAdmin.from); from.mockReset().mockReturnValue(q as never);
  const r = await POST(new NextRequest('http://localhost/api/notifications/newInboundMessage',{method:'POST', body:JSON.stringify({lead_id:lead,conversation_id:conversation,message:'Hello'})}));
  expect(r.status).toBe(404); expect(from.mock.calls).toEqual([['conversations']]);
});
