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
const receipt = z.object({connector_id:uuid, revision, direct_revision:revision, enabled:z.boolean(), attested:z.boolean()}).strict();
type Context = { params:Promise<{id:string}> };

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
    const {data,error} = await (body ? supabaseAdmin.rpc('connector_set_direct_policy',{
      ...args,p_expected_revision:body.expected_revision,p_expected_direct_revision:body.expected_direct_revision,p_enabled:body.enabled,
    }) : supabaseAdmin.rpc('connector_direct_policy',args)).abortSignal(AbortSignal.timeout(5_000));
    if (error?.code==='P0D01') throw new ConnectorError('DIRECT_ATTESTATION_REQUIRED','Current operator attestation of an isolated account is required.',409);
    if (error) connectorDatabaseError(error);
    const saved = receipt.safeParse(data);
    if (!saved.success || saved.data.connector_id!==id || (saved.data.enabled && !saved.data.attested) ||
      (body && (saved.data.revision!==body.expected_revision || saved.data.direct_revision!==body.expected_direct_revision+1 || saved.data.enabled!==body.enabled))) {
      throw new ConnectorError('STORAGE_UNAVAILABLE','The direct policy could not be confirmed. Reload before retrying.',503);
    }
    return Response.json(saved.data,{headers});
  } catch (error) { return handleConnectorError(error); }
}
export function GET(req:Request,ctx:Context) { return policy(req,ctx,false); }
export function PATCH(req:Request,ctx:Context) { return policy(req,ctx,true); }
