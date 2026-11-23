import { z } from 'zod';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { readCatalogJson } from '@/lib/services/catalog-search/request-body';
import { connectorQuery, requireConnectorActor, handleConnectorError } from '@/lib/connectors/http';
import { connectorDatabaseError, requireConnectorSiteAccess } from '@/lib/connectors/account-access';
import { ConnectorError } from '@/lib/connectors/types';

export const runtime = 'nodejs';
const headers = { 'Cache-Control': 'private, no-store' };
const uuid = z.string().uuid();
const query = z.object({site_id:uuid}).strict();
const revision = z.number().int().positive().max(2_147_483_647);
const expected = revision.max(2_147_483_646);
const patch = query.extend({expected_revision:expected, expected_direct_revision:expected, enabled:z.boolean()}).strict();
const receipt = z.object({connector_id:uuid, revision, direct_revision:revision, enabled:z.boolean(), attested:z.boolean(),
  setup_pending:z.boolean(), bound_supabase_ref:z.string().length(20).regex(/^[a-z]{20}$/).nullable()}).strict();
const memberStatus = receipt.extend({authorization_mode:z.literal('member_policy'),explicitly_disabled:z.boolean()}).strict();
type Context = { params:Promise<{id:string}> };

async function snapshot(args:{p_site_id:string;p_actor_id:string;p_connector_id:string}, change?:z.infer<typeof patch>) {
  const rpc = change ? 'connector_set_ask_policy' : 'connector_instance_policy_status';
  let result=await supabaseAdmin.rpc(rpc,change ? {...args,p_expected_revision:change.expected_revision,
    p_expected_direct_revision:change.expected_direct_revision,p_enabled:change.enabled} : args).abortSignal(AbortSignal.timeout(5_000));
  // Only downgrade a status read on an older DB, never retry a mutation or an authorization failure.
  const legacy=!change && result.error?.code==='PGRST202';
  if (legacy) result=await supabaseAdmin.rpc('connector_ask_policy_status',args).abortSignal(AbortSignal.timeout(5_000));
  const {data,error}=result;
  if (error?.code==='P0D01') throw new ConnectorError('DIRECT_ATTESTATION_REQUIRED','This connection is not verified for Ask.',409);
  if (error) connectorDatabaseError(error);
  const saved=change || legacy ? receipt.safeParse(data) : memberStatus.safeParse(data);
  if (saved.success && 'explicitly_disabled' in saved.data && saved.data.explicitly_disabled && saved.data.enabled) {
    throw new ConnectorError('STORAGE_UNAVAILABLE','Contradictory connector policy state.',503);
  }
  if (!saved.success || saved.data.connector_id!==args.p_connector_id || (saved.data.enabled && (!saved.data.attested || saved.data.setup_pending)) ||
    (change && (saved.data.revision!==change.expected_revision || saved.data.direct_revision!==change.expected_direct_revision+1 || saved.data.enabled!==change.enabled || saved.data.setup_pending))) {
    throw new ConnectorError('STORAGE_UNAVAILABLE','Ask access could not be confirmed. Reload before retrying.',503);
  }
  return saved.data;
}

async function policy(req:Request, ctx:Context, write:boolean) {
  try {
    const actor = await requireConnectorActor(req);
    const id = uuid.parse((await ctx.params).id);
    let body:z.infer<typeof patch>|undefined;
    if (write) {
      if (new URL(req.url).search) throw new ConnectorError('INVALID_REQUEST','Mutation parameters belong in the JSON body.',400);
      if (req.headers.get('content-type')?.split(';')[0].trim().toLowerCase()!=='application/json') {
        throw new ConnectorError('JSON_REQUIRED','JSON content type required.',415);
      }
      body = patch.parse(await readCatalogJson(req,2048));
    }
    const site = body?.site_id ?? query.parse(connectorQuery(req)).site_id;
    await requireConnectorSiteAccess(site,actor,true);
    const args = {p_site_id:site,p_actor_id:actor,p_connector_id:id};
    // The manager RPC authorizes the account and verifies current isolation and revisions atomically.
    // Discard the legacy internal binding field; it is neither a browser grant nor a second policy.
    const {bound_supabase_ref: _internal,...display}=await snapshot(args,body);
    return Response.json(display,{headers});
  } catch (error) { return handleConnectorError(error); }
}
export function GET(req:Request,ctx:Context) { return policy(req,ctx,false); }
export function PATCH(req:Request,ctx:Context) { return policy(req,ctx,true); }
