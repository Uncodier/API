import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { resolveToolRequestPrincipal, canToolPrincipalAccessSite } from '@/lib/security/tool-request-principal';
import { resolveHttpExecutionRouting, withHttpExecutionRouting } from '@/lib/services/ai/customer-routing-http';
import { canReadProcurementWorkflowInstanceAsActor } from '@/lib/services/workflow-robot/procurement-access';

/** Authenticate even legacy site-less calls before provisioning, inference or plan writes. */
export async function admitActRequest(request: NextRequest, handler: (request: NextRequest) => Promise<NextResponse>) {
  try {
    const principal = await resolveToolRequestPrincipal(request);
    if (!principal) return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
    const body = await request.clone().json();
    if (!body || !z.string().uuid().safeParse(body.instance_id).success) {
      return NextResponse.json({ error: 'Invalid instance' }, { status: 400 });
    }
    const { data: instance, error } = await supabaseAdmin.from('remote_instances')
      .select('site_id').eq('id', body.instance_id).single();
    if (error || !instance) return NextResponse.json({ error: 'Instance not found' }, { status: 404 });
    if ((body.site_id && body.site_id !== instance.site_id) ||
      (!principal.internal && body.user_id && body.user_id !== principal.userId) ||
      !await canToolPrincipalAccessSite(principal, instance.site_id) || (!principal.internal &&
      !await canReadProcurementWorkflowInstanceAsActor(instance.site_id, body.instance_id, principal.userId))) {
      return NextResponse.json({ error: 'Instance access denied' }, { status: 403 });
    }
    const routing = await resolveHttpExecutionRouting(request, instance.site_id);
    return await withHttpExecutionRouting(request, routing, () => handler(request));
  } catch (error: any) {
    return NextResponse.json({ error: 'Instance admission failed' }, { status: error instanceof SyntaxError ? 400 : error?.status ?? 503 });
  }
}