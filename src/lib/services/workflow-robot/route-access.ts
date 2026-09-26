import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { hasAuthenticatedPrincipal, isInternalServiceRequest } from '@/lib/security/request-rate-limit';
import { canAccessSite, getRequestSitePrincipal } from '@/lib/security/site-access';
import { isSiteSkillManager } from '@/lib/services/site-skill-access';

const UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;

/** Check canonical tenant ownership before any service-role workflow run, not just instance routes. */
export async function authorizeWorkflowSiteWrite(request: Request, siteId: string): Promise<NextResponse | null> {
  if (!await canAccessSite(request, siteId)) {
    return NextResponse.json({ error: 'Workflow is not accessible' }, { status: 403 });
  }
  if (!isInternalServiceRequest(request)) {
    const { userId } = getRequestSitePrincipal(request);
    if (!userId || !await isSiteSkillManager(siteId, userId)) {
      return NextResponse.json({ error: 'Workflow management is not permitted' }, { status: 403 });
    }
  }
  return null;
}

/** Workflow writes use service-role access; bind the caller to the instance's actual site first. */
export async function authorizeWorkflowInstanceWrite(
  request: Request,
  instanceId: string,
): Promise<NextResponse | null> {
  if (!hasAuthenticatedPrincipal(request)) {
    return NextResponse.json({ error: 'Authentication is required' }, { status: 401 });
  }
  if (!UUID.test(instanceId)) {
    return NextResponse.json({ error: 'Invalid workflow instance' }, { status: 400 });
  }

  const { data: instance, error } = await supabaseAdmin.from('remote_instances')
    .select('site_id').eq('id', instanceId).maybeSingle();
  if (error) throw error;
  if (!instance) {
    return NextResponse.json({ error: 'Workflow is not accessible' }, { status: 403 });
  }
  return authorizeWorkflowSiteWrite(request, instance.site_id);
}

export async function authorizeWorkflowRunWrite(request: Request, runPlanId: string): Promise<NextResponse | null> {
  if (!hasAuthenticatedPrincipal(request)) {
    return NextResponse.json({ error: 'Authentication is required' }, { status: 401 });
  }
  if (!UUID.test(runPlanId)) {
    return NextResponse.json({ error: 'Invalid workflow run' }, { status: 400 });
  }
  const { data: run, error } = await supabaseAdmin.from('workflow_runs')
    .select('site_id, instance_id').eq('run_plan_id', runPlanId).maybeSingle();
  if (error) throw error;
  if (!run) {
    return NextResponse.json({ error: 'Workflow is not accessible' }, { status: 403 });
  }
  const { data: instance, error: instanceError } = await supabaseAdmin.from('remote_instances')
    .select('site_id').eq('id', run.instance_id).maybeSingle();
  if (instanceError) throw instanceError;
  if (!instance || instance.site_id !== run.site_id) {
    return NextResponse.json({ error: 'Workflow is not accessible' }, { status: 403 });
  }
  return authorizeWorkflowSiteWrite(request, instance.site_id);
}