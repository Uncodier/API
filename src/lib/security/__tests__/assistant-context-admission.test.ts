import { NextRequest } from 'next/server';
import { randomUUID } from 'node:crypto';
import { GET } from '@/app/api/robots/instance/context/route';
import { assistantInstanceAccess } from '../assistant-instance-access';
import { resolveToolRequestPrincipal,canToolPrincipalAccessSite } from '../tool-request-principal';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { InstanceContextManager } from '@/lib/services/robot-instance/InstanceContextManager';

jest.mock('../assistant-instance-access',()=>({assistantInstanceAccess:jest.fn()}));
jest.mock('../tool-request-principal',()=>({resolveToolRequestPrincipal:jest.fn(),canToolPrincipalAccessSite:jest.fn()}));
jest.mock('@/lib/database/supabase-client',()=>({supabaseAdmin:{from:jest.fn()}}));
jest.mock('@/lib/services/robot-instance/InstanceContextManager',()=>({InstanceContextManager:jest.fn()}));
const id=randomUUID(),site=randomUUID(),user=randomUUID();const row={id,site_id:site,user_id:user};
const request=()=>new NextRequest(`https://api.example.test/api/robots/instance/context?instance_id=${id}`);
beforeEach(()=>{
  jest.resetAllMocks(); jest.mocked(resolveToolRequestPrincipal).mockResolvedValue({internal:false,userId:user,siteId:null,userSession:true});
  jest.mocked(canToolPrincipalAccessSite).mockResolvedValue(true);
  const chain={select:jest.fn().mockReturnThis(),eq:jest.fn().mockReturnThis(),maybeSingle:jest.fn().mockResolvedValue({data:row,error:null})};
  (supabaseAdmin.from as jest.Mock).mockReturnValue(chain);
});
it('never reads an instance or its context before authentication',async()=>{
  jest.mocked(resolveToolRequestPrincipal).mockResolvedValue(null); expect((await GET(request())).status).toBe(401);
  expect(supabaseAdmin.from).not.toHaveBeenCalled(); expect(InstanceContextManager).not.toHaveBeenCalled();
});
it.each([403,404,503] as const)('never uses the admin context reader for an unavailable row (%s)',async code=>{
  jest.mocked(assistantInstanceAccess).mockResolvedValue(code); expect((await GET(request())).status).toBe(code);
  expect(InstanceContextManager).not.toHaveBeenCalled();
});
it('uses the verified instance site after both access checks',async()=>{
  jest.mocked(assistantInstanceAccess).mockResolvedValue(200); const status=jest.fn().mockResolvedValue({usedTokens:42});
  (InstanceContextManager as jest.Mock).mockImplementation(()=>({status}));
  const result=await GET(request()); expect(await result.json()).toEqual({context:{usedTokens:42}});
  expect(InstanceContextManager).toHaveBeenCalledWith(id,site);expect(status).toHaveBeenCalledTimes(1);
});
