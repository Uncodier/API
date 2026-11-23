import 'server-only';
import {z} from 'zod';
import {supabaseAdmin} from '@/lib/database/supabase-client';
import type {scopedAdmission} from './instance-scoped-contract';
import type {DirectReport} from './provider-direct-output';
import type {AnalyticsScope} from './supabase-analytics-sources';
import {ConnectorError} from './types';

type Request = Awaited<ReturnType<typeof scopedAdmission>>['actor'] & {
  p_version:string; p_schema_hash:string; p_source:string; p_data_scope:AnalyticsScope;
};
const id = z.string().uuid();
const reservationUnknown = () => new ConnectorError('DIRECT_DISPATCH_UNCONFIRMED','The scoped read reservation could not be confirmed. Do not repeat it.',503);
const deliveryUnknown = () => new ConnectorError('DIRECT_RESULT_UNCONFIRMED','The read was sent, but private delivery could not be confirmed.',503);
const denied = (scope:AnalyticsScope) => new ConnectorError(scope==='workspace'?'ANALYTICS_WORKSPACE_DENIED':'ANALYTICS_SCOPE_DENIED',
  'The exact analytics source and scope are not authorized for this turn.',403);

export async function claimScopedRead(request:Request,digest:string):Promise<string> {
  let result;
  try {
    result = await supabaseAdmin.rpc('claim_connector_instance_scoped_read',{...request,p_arguments_digest:digest}).abortSignal(AbortSignal.timeout(5000));
  } catch { throw reservationUnknown(); }
  if (result?.error?.code === '42501') throw denied(request.p_data_scope);
  if (result?.error?.code === 'P0D03') throw new ConnectorError('DIRECT_DISPATCH_ALREADY_CLAIMED','This read was already reserved for the original turn.',409);
  if (result?.error !== null || !id.safeParse(result.data).success) throw reservationUnknown();
  return result.data;
}

export async function storeScopedRead(request:Request,claimId:string,report:DirectReport,recheck:()=>Promise<void>):Promise<string> {
  if (!id.safeParse(claimId).success) throw deliveryUnknown();
  const payload = {...request,p_claim_id:claimId,p_report:structuredClone(report)};
  // Only a lost storage acknowledgment is recoverable, using the identical DTO and claim.
  // Each attempt also checks the original source/entitlement epoch inside the transaction.
  for (let attempt=0; attempt<2; attempt++) {
    await recheck();
    let result;
    try {
      result = await supabaseAdmin.rpc('store_connector_instance_scoped_read',payload).abortSignal(AbortSignal.timeout(5000));
    } catch { continue; }
    if (result?.error === null && id.safeParse(result.data).success) return result.data;
    if (result?.error?.code === '42501') throw denied(request.p_data_scope);
    if (result?.error?.code === 'P0D04' || ![0,502,503,504].includes(result?.status)) break;
  }
  throw deliveryUnknown();
}
