import { randomBytes, randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { handleOpenRouter } from '../http';
import { readConnection } from '../store';
import { mutateConnection } from '../management';
jest.mock('@supabase/supabase-js', () => ({createClient:jest.fn()}));
jest.mock('../store', () => ({readConnection:jest.fn()}));
jest.mock('../management', () => ({...jest.requireActual('../management'),mutateConnection:jest.fn()}));
const siteId = randomUUID(), actorId = randomUUID(), bearer = randomBytes(24).toString('hex');
const auth = jest.fn(), role = jest.fn();
function req(body?: unknown, token: string | null = bearer) {
  return new Request(`https://api.example.test/api/integrations/openrouter?siteId=${siteId}`, {method:body ? 'POST':'GET',headers:{...(token ? {authorization:`Bearer ${token}`} : {}),'content-type':'application/json','x-api-key-data':JSON.stringify({user_id:actorId,role:'owner'})},...(body ? {body:JSON.stringify(body)} : {})});
}
beforeEach(() => {
  jest.clearAllMocks(); process.env.NEXT_PUBLIC_SUPABASE_URL='https://project.example.test'; process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY=randomBytes(24).toString('hex');
  jest.mocked(createClient).mockReturnValue({auth:{getUser:auth},rpc:role} as never);
  auth.mockResolvedValue({data:{user:{id:actorId}},error:null}); role.mockResolvedValue({data:'owner',error:null});
  jest.mocked(readConnection).mockResolvedValue(null); jest.mocked(mutateConnection).mockResolvedValue({connection:null} as never);
});
test.each(['read','models','mutate','setup'] as const)('%s independently denies missing auth and spoofed headers', async action => {
  const body = action === 'mutate' ? {operation:'disconnect',siteId,expectedRevision:1}:undefined;
  expect((await handleOpenRouter(req(body,null),action)).status).toBe(401);
  expect(createClient).not.toHaveBeenCalled(); expect(readConnection).not.toHaveBeenCalled(); expect(mutateConnection).not.toHaveBeenCalled();
});
test.each(['member','collaborator',null])('denies non-manager/cross-tenant role %s', async value => {
  role.mockResolvedValue({data:value,error:null});
  expect((await handleOpenRouter(req(),'read')).status).toBe(403); expect(readConnection).not.toHaveBeenCalled();
});
test.each(['owner','admin'])('authorizes %s with verified JWT, not service-role/header claims', async value => {
  role.mockResolvedValue({data:value,error:null}); const response = await handleOpenRouter(req(),'read');
  expect(response.status).toBe(200); expect(auth).toHaveBeenCalledWith(bearer); expect(role).toHaveBeenCalledWith('current_user_site_role',{p_site_id:siteId});
  expect(response.headers.get('cache-control')).toBe('no-store'); expect(await response.json()).toMatchObject({connection:null,canManage:true});
  expect(jest.mocked(createClient).mock.calls[0][2]).toMatchObject({global:{headers:{Authorization:`Bearer ${bearer}`}}});
});
test('forwards only verified actor after strict validation', async () => {
  const input = {operation:'configure',siteId,expectedRevision:1,capabilities:{text:{mode:'disabled'}}};
  expect((await handleOpenRouter(req(input),'mutate')).status).toBe(200);
  expect(mutateConnection).toHaveBeenCalledWith(actorId,input);
  expect((await handleOpenRouter(req({...input,userId:randomUUID()}),'mutate')).status).toBe(400);
});
test('malformed and oversized requests are rejected; upstream errors never leak', async () => {
  expect((await handleOpenRouter(new Request('https://api.example.test?siteId=invalid'),'read')).status).toBe(400);
  expect((await handleOpenRouter(req({operation:'connect',siteId,expectedRevision:0,apiKey:'x'.repeat(33000),consent:true}),'mutate')).status).toBe(413);
  const secret=randomBytes(24).toString('hex'); jest.mocked(readConnection).mockRejectedValue(new Error(secret));
  const response=await handleOpenRouter(req(),'read'); expect(response.status).toBe(503); expect(await response.text()).not.toContain(secret);
});
test('auth outage is not an empty disconnected state', async () => {
  role.mockResolvedValue({data:null,error:{message:'private'}});
  expect((await handleOpenRouter(req(),'read')).status).toBe(503); expect(readConnection).not.toHaveBeenCalled();
});

test('duplicate query siteIds are rejected before auth', async () => {
  const request = new Request(`https://api.example.test?siteId=${siteId}&siteId=${randomUUID()}`);
  expect((await handleOpenRouter(request,'read')).status).toBe(400); expect(createClient).not.toHaveBeenCalled();
});
