import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { canToolPrincipalAccessSite, resolveToolRequestPrincipal } from '@/lib/security/tool-request-principal';
import { assistantInstanceAccess } from '@/lib/security/assistant-instance-access';
import { InstanceContextManager } from '@/lib/services/robot-instance/InstanceContextManager';

export async function GET(request: NextRequest) {
  const id = z.string().uuid().safeParse(request.nextUrl.searchParams.get('instance_id'));
  if (!id.success) return NextResponse.json({ error: 'Invalid instance_id' }, { status: 400 });
  const principal = await resolveToolRequestPrincipal(request);
  if (!principal) return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
  const { data: instance, error } = await supabaseAdmin.from('remote_instances')
    .select('id,site_id,user_id').eq('id', id.data).maybeSingle();
  if (error) return NextResponse.json({ error: 'Instance lookup failed' }, { status: 503 });
  if (!instance) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (!await canToolPrincipalAccessSite(principal, instance.site_id)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  const read = await assistantInstanceAccess(request, principal, instance);
  if (read !== 200) return NextResponse.json({ error: read === 503 ? 'Instance verification unavailable' : 'Instance unavailable' }, { status: read });
  return NextResponse.json({ context: await new InstanceContextManager(id.data, instance.site_id).status() });
}