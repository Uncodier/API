import 'server-only';
import { supabaseAdmin } from '@/lib/database/supabase-server';
import { z } from 'zod';
import { evaluateCapabilities } from './catalog';
import { publishConnection } from './store';
import { OpenRouterError, type ConnectionRow } from './types';

const proofSchema = z.object({ connection_id:z.string().uuid(), credential_version:z.number().int().positive(),kind:z.literal('verify'),state:z.literal('completed'),
  finished_at:z.string(), evidence:z.object({modelId:z.string(),artifactId:z.string(),adapterVersion:z.literal('openrouter-images-png-v1'),providerTag:z.string()}) });

/** Publish existing paid evidence only. This path never decrypts a credential or calls a provider. */
export async function recoverImageVerification(row:ConnectionRow,actorId:string,operationId:string):Promise<ConnectionRow>{
  const {data,error}=await supabaseAdmin.from('openrouter_setup_runs').select('connection_id,credential_version,kind,state,finished_at,evidence')
    .eq('site_id',row.site_id).eq('operation_id',operationId).maybeSingle();
  const parsed=proofSchema.safeParse(data);
  if(error||!parsed.success)throw new OpenRouterError('verification_recovery_unavailable','Completed image verification evidence is unavailable',409);
  const saved=parsed.data;
  const expiry=Date.parse(saved.finished_at)+23*60*60*1000;
  if(saved.connection_id!==row.id||saved.credential_version!==row.credential_version||row.status!=='connected'
    ||!Number.isFinite(expiry)||expiry<=Date.now()||row.capabilities.image.modelId!==saved.evidence.modelId){
    throw new OpenRouterError('verification_recovery_mismatch','The completed verification no longer matches the current image model or credential',409);
  }
  const capabilities=structuredClone(row.capabilities);
  capabilities.image.verification={...saved.evidence,modelId:saved.evidence.modelId,credentialVersion:row.credential_version,
    expiresAt:new Date(expiry).toISOString(),operationId};
  return publishConnection(row.site_id,actorId,row.revision,{...row,capabilities:evaluateCapabilities(capabilities,row.catalog)});
}