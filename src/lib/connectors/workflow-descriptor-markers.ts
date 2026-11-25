import 'server-only';
import { z } from 'zod';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { denied, type WorkflowActor } from './workflow-read-binding';

const marker = z.string().min(1).max(200);
const markers = z.tuple([z.string().uuid(), marker, marker, marker, z.string().uuid()]);
/** Internal only. These values are used solely for rejecting reflected descriptor metadata. */
export async function workflowDescriptorMarkers(actor: WorkflowActor): Promise<string[]> {
  const {data,error}=await supabaseAdmin.rpc('workflow_connector_descriptor_markers', {
    p_site:actor.site_id,p_connector:actor.connector_id,p_actor:actor.principal_id,p_tool:actor.tool_slug,
  }).abortSignal(AbortSignal.timeout(5000));
  const parsed=markers.safeParse(data);
  if (error || !parsed.success) denied();
  return parsed.data;
}
