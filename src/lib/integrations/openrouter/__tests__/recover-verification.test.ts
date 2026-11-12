import {randomUUID} from 'node:crypto';
import {supabaseAdmin} from '@/lib/database/supabase-server';
import {recoverImageVerification} from '../recover-verification';
import {publishConnection} from '../store';
import {emptyCapabilities} from '../catalog';
import type {ConnectionRow} from '../types';
jest.mock('@/lib/database/supabase-server',()=>({supabaseAdmin:{from:jest.fn()}}));
jest.mock('../store',()=>({publishConnection:jest.fn()}));
const id=randomUUID(),siteId=randomUUID(),operationId=randomUUID();
let row:ConnectionRow;let saved:any;let query:any;
beforeEach(()=>{
  jest.clearAllMocks();row={id,site_id:siteId,revision:5,policy_version:5,credential_version:1,status:'connected',selected:false,encrypted_credential:'synthetic',catalog_updated_at:null,verified_at:null,consent_at:null,updated_at:'',capabilities:emptyCapabilities(),catalog:[{id:'vendor/image',name:'Image',inputModalities:['text'],outputModalities:['image'],supportedParameters:[],contextLength:null,endpoints:['/api/v1/images']}]};
  row.capabilities.image={mode:'manual',modelId:'vendor/image',status:'unavailable',reason:'Unverified'};
  saved={connection_id:id,credential_version:1,kind:'verify',state:'completed',finished_at:new Date().toISOString(),evidence:{modelId:'vendor/image',artifactId:randomUUID(),adapterVersion:'openrouter-images-png-v1',providerTag:'provider/pinned'}};
  query={select:jest.fn(()=>query),eq:jest.fn(()=>query),maybeSingle:jest.fn(async()=>({data:saved,error:null}))};
  jest.mocked(supabaseAdmin.from).mockReturnValue(query);jest.mocked(publishConnection).mockImplementation(async(_s,_a,_r,candidate)=>candidate);
});
test('publishes previously paid proof against the latest revision with no provider request',async()=>{
  const fetcher=jest.spyOn(globalThis,'fetch');
  try{
    const result=await recoverImageVerification(row,randomUUID(),operationId);
    expect(result.capabilities.image).toMatchObject({status:'available',verification:{operationId,modelId:'vendor/image',credentialVersion:1}});
    expect(publishConnection).toHaveBeenCalledWith(siteId,expect.any(String),5,expect.any(Object));
    expect(query.eq).toHaveBeenCalledWith('site_id',siteId);expect(fetcher).not.toHaveBeenCalled();
  }finally{fetcher.mockRestore();}
});
test.each(['rotated','expired','different-model','uncertain'])('refuses %s evidence without spending or publishing',async(reason)=>{
  if(reason==='rotated')row.credential_version=2;
  if(reason==='expired')saved.finished_at='2000-01-01T00:00:00Z';
  if(reason==='different-model')row.capabilities.image.modelId='other/image';
  if(reason==='uncertain')saved.state='uncertain';
  await expect(recoverImageVerification(row,randomUUID(),operationId)).rejects.toThrow();expect(publishConnection).not.toHaveBeenCalled();
});