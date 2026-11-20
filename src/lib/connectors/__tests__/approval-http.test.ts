import { randomBytes, randomUUID } from 'node:crypto';
import { POST } from '@/app/api/connectors/approvals/[id]/[decision]/route';
import { GET } from '@/app/api/connectors/approvals/route';
import { decideConnectorApproval, listConnectorApprovals } from '../approval-decisions';
const getUser = jest.fn();
jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { auth: { getUser: (...args: unknown[]) => getUser(...args) } } }));
jest.mock('../approval-decisions', () => ({ decideConnectorApproval: jest.fn(), listConnectorApprovals: jest.fn() }));
const id = randomUUID(), user = randomUUID(), site = randomUUID();
const headers = { 'content-type':'application/json', authorization:`Bearer ${randomBytes(32).toString('hex')}` };
const path = { params: Promise.resolve({ id, decision:'approve' }) };
function post(body: unknown, auth = true) {
  return new Request('https://example.test/decision', { method:'POST', headers:auth ? headers : {'x-api-key-data': JSON.stringify({user_id:user})}, body:JSON.stringify(body) });
}
beforeEach(() => { jest.resetAllMocks(); getUser.mockResolvedValue({data:{user:{id:user}},error:null}); });
test('both routes reject service identity and unauthenticated public channels', async () => {
  expect((await GET(new Request('https://example.test/'))).status).toBe(401);
  expect((await POST(post({site_id:site},false), path)).status).toBe(401);
  expect(decideConnectorApproval).not.toHaveBeenCalled(); expect(listConnectorApprovals).not.toHaveBeenCalled();
});
test('unknown fields, invalid decisions, UUIDs, repeated query rejected', async () => {
  for (const key of ['arguments','agent_id','user_id','approved','connector_id','source','context']) {
    expect((await POST(post({site_id:site,[key]:id}),path)).status).toBe(400);
  }
  expect((await POST(post({site_id:site}),{params:Promise.resolve({id,decision:'execute'})})).status).toBe(400);
  expect((await POST(post({site_id:'invalid'}),path)).status).toBe(400);
  expect((await GET(new Request(`https://example.test/?site_id=${site}&site_id=${site}`, {headers}))).status).toBe(400);
  expect(decideConnectorApproval).not.toHaveBeenCalled(); expect(listConnectorApprovals).not.toHaveBeenCalled();
});
test('only verified bearer actor and site/id/decision go to service, private no-store', async () => {
  jest.mocked(decideConnectorApproval).mockResolvedValue({ id, status:'completed', result:{count:1} });
  const response = await POST(post({site_id:site}),path);
  expect(decideConnectorApproval).toHaveBeenCalledWith(site,id,user,'approve');
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(await response.json()).toEqual({id,status:'completed',result:{count:1}});
});
