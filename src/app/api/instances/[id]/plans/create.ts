import { NextResponse } from 'next/server';
import { z } from 'zod';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { resolveToolRequestPrincipal, canToolPrincipalAccessSite } from '@/lib/security/tool-request-principal';
import { canReadProcurementWorkflowInstanceAsActor } from '@/lib/services/workflow-robot/procurement-access';
import { resolveHttpExecutionRouting } from '@/lib/services/ai/customer-routing-http';
import { pinPlanRouting } from '@/lib/services/workflow-robot/plan-routing';

const schema = z.object({
  title: z.string().trim().min(1).max(300),
  description: z.string().max(20000).optional(),
  plan_type: z.enum(['task', 'objective']).default('task'),
  status: z.enum(['pending', 'blocked']).default('pending'),
  steps: z.array(z.object({
    id: z.string().max(200).optional(), title: z.string().max(1000),
    description: z.string().max(20000).optional(), instructions: z.string().max(20000).optional(),
    expected_output: z.string().max(20000).optional(),
  }).strict()).max(100).default([]),
}).strict();

export async function createPlan(request: Request, id: string) {
  try {
    const principal = await resolveToolRequestPrincipal(request);
    if (!principal) return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
    if (!z.string().uuid().safeParse(id).success) return NextResponse.json({ error: 'Invalid instance' }, { status: 400 });
    const parsed = schema.safeParse(await request.json());
    if (!parsed.success) return NextResponse.json({ error: 'Invalid plan' }, { status: 400 });
    const { data: instance, error } = await supabaseAdmin.from('remote_instances')
      .select('site_id, user_id').eq('id', id).single();
    if (error || !instance) return NextResponse.json({ error: 'Instance not found' }, { status: 404 });
    if (!await canToolPrincipalAccessSite(principal, instance.site_id) || (!principal.internal &&
      !await canReadProcurementWorkflowInstanceAsActor(instance.site_id, id, principal.userId))) {
      return NextResponse.json({ error: 'Instance access denied' }, { status: 403 });
    }
    const routing = await resolveHttpExecutionRouting(request, instance.site_id);
    const { status, steps, ...fields } = parsed.data;
    const { data: plan, error: insertError } = await supabaseAdmin.from('instance_plans').insert({
      ...fields, steps: steps.map((step, index) => ({ ...step, order: index + 1, status: 'pending' })),
      status: 'blocked', instance_id: id, site_id: instance.site_id,
      user_id: principal.userId ?? instance.user_id, steps_total: steps.length, steps_completed: 0,
    }).select().single();
    if (insertError || !plan) throw new Error('Plan creation failed');
    await pinPlanRouting(plan.id, instance.site_id, routing);
    if (status !== 'blocked') {
      const { error: publishError } = await supabaseAdmin.from('instance_plans')
        .update({ status }).eq('id', plan.id).eq('status', 'blocked');
      if (publishError) throw new Error('Plan publication failed');
    }
    return NextResponse.json({ plan: { ...plan, status }, message: 'Plan created successfully' }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: 'Plan creation failed' }, { status: error instanceof SyntaxError ? 400 : 503 });
  }
}