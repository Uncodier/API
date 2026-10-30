import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { assertToolScreenAccess } from '@/app/api/agents/tools/router/screen-access';
import { createCloudFileStore, CloudFileStoreError } from '@/lib/cloud-files/store';
import { archiveCloudRevision, readAuthorizedCloudRevision, validateCloudRevision } from '@/lib/cloud-files/archive';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Bearer identity is verified here, not inferred from caller-supplied proxy headers. */
export async function GET(request: NextRequest, context: { params: Promise<{ instanceId: string; fileId: string }> }) {
  const ids = z.object({ instanceId: z.string().uuid(), fileId: z.string().uuid() }).safeParse(await context.params);
  const version = z.coerce.number().int().positive().max(2147483647).safeParse(request.nextUrl.searchParams.get('version'));
  const format = request.nextUrl.searchParams.get('format') ?? 'text';
  if (!ids.success || !version.success || !['text', 'zip'].includes(format)) {
    return NextResponse.json({ error: 'Invalid cloud revision request' }, { status: 400 });
  }
  const authorization = request.headers.get('authorization');
  if (!authorization?.startsWith('Bearer ')) return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
  try {
    const { data: identity, error: authError } = await supabaseAdmin.auth.getUser(authorization.slice(7));
    if (authError || !identity.user) return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
    const { data: instance, error } = await supabaseAdmin.from('remote_instances').select('site_id')
      .eq('id', ids.data.instanceId).maybeSingle();
    if (error) return NextResponse.json({ error: 'Cloud files unavailable' }, { status: 503 });
    if (!instance) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    const scope = { siteId: instance.site_id, userId: identity.user.id, instanceId: ids.data.instanceId };
    const assertActive = () => assertToolScreenAccess('read_cloud_file', scope);
    await assertActive();
    const store = createCloudFileStore();
    const revision = await store.read(scope, ids.data.fileId, version.data);
    if (!revision) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    const bytes = format === 'zip' ? await archiveCloudRevision(scope, revision, { store, assertActive })
      : validateCloudRevision(await readAuthorizedCloudRevision(scope, revision, { store, assertActive }));
    await assertActive();
    return new NextResponse(new Uint8Array(bytes), { headers: {
      'Content-Type': format === 'zip' ? 'application/zip' : 'text/plain; charset=utf-8',
      'Content-Disposition': `attachment; filename="${revision.file_id}-v${revision.version}.${format === 'zip' ? 'zip' : 'txt'}"`,
      'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox", 'X-Cloud-File-Sha256': revision.sha256,
    } });
  } catch (error) {
    const status = error instanceof CloudFileStoreError ? error.code === 'forbidden' ? 403 : error.code === 'not_found' ? 404 : 503
      : (error as { status?: number })?.status === 403 ? 403 : 503;
    return NextResponse.json({ error: status === 403 ? 'Forbidden' : status === 404 ? 'Not found' : 'Cloud files unavailable' }, { status });
  }
}