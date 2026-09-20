import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import {
  canAccessSite,
  getRequestSitePrincipal,
} from '@/lib/security/site-access';

const createSiteSchema = z.object({
  name: z.string().trim().min(1).max(200),
  domain: z.string().trim().max(253).optional(),
});

const siteIdSchema = z.string().uuid();

function forbidden() {
  return NextResponse.json(
    { success: false, error: { code: 'forbidden', message: 'Site access is required' } },
    { status: 403 },
  );
}

export async function POST(request: NextRequest) {
  try {
    const principal = getRequestSitePrincipal(request);
    if (!principal.internal && (!principal.userId || principal.siteId)) {
      return forbidden();
    }
    const input = createSiteSchema.parse(await request.json());
    const siteUrl = input.domain
      ? (/^https?:\/\//i.test(input.domain) ? input.domain : `https://${input.domain}`)
      : null;
    const { data: site, error } = await supabaseAdmin
      .from('sites')
      .insert({
        name: input.name,
        url: siteUrl,
        user_id: principal.userId,
      })
      .select('id, name, url, user_id, created_at, updated_at')
      .single();
    if (error) {
      console.error('[Visitor Sites] Site creation failed:', error);
      return NextResponse.json(
        { success: false, error: { code: 'site_creation_error', message: 'Error creating site' } },
        { status: 500 },
      );
    }
    return NextResponse.json({ success: true, site }, { status: 201 });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { success: false, error: { code: 'invalid_parameters', message: 'Invalid request parameters' } },
        { status: 400 },
      );
    }
    console.error('[Visitor Sites] Unexpected creation error:', error);
    return NextResponse.json(
      { success: false, error: { code: 'internal_error', message: 'Internal server error' } },
      { status: 500 },
    );
  }
}

export async function GET(request: NextRequest) {
  try {
    const rawId = request.nextUrl.searchParams.get('id');
    if (rawId) {
      const id = siteIdSchema.parse(rawId);
      if (!await canAccessSite(request, id)) return forbidden();
      const { data: site, error } = await supabaseAdmin
        .from('sites')
        .select('id, name, url, user_id, created_at, updated_at')
        .eq('id', id)
        .maybeSingle();
      if (error) throw error;
      if (!site) {
        return NextResponse.json(
          { success: false, error: { code: 'site_not_found', message: 'Site not found' } },
          { status: 404 },
        );
      }
      return NextResponse.json({ success: true, site });
    }

    const principal = getRequestSitePrincipal(request);
    const baseQuery = () => supabaseAdmin
      .from('sites')
      .select('id, name, url, user_id, created_at, updated_at')
      .order('created_at', { ascending: false })
      .limit(100);
    if (principal.siteId) {
      const { data: sites, error } = await baseQuery().eq('id', principal.siteId);
      if (error) throw error;
      return NextResponse.json({ success: true, sites: sites ?? [] });
    }
    if (!principal.internal && !principal.userId) {
      return forbidden();
    }
    if (principal.internal) {
      const { data: sites, error } = await baseQuery();
      if (error) throw error;
      return NextResponse.json({ success: true, sites: sites ?? [] });
    }

    const [{ data: directSites, error: directError }, { data: ownerships, error: ownershipError }] =
      await Promise.all([
        baseQuery().eq('user_id', principal.userId),
        supabaseAdmin
          .from('site_ownership')
          .select('site_id')
          .eq('user_id', principal.userId)
          .limit(100),
      ]);
    if (directError || ownershipError) throw directError || ownershipError;
    const directIds = new Set((directSites ?? []).map((site) => site.id));
    const ownedIds = (ownerships ?? [])
      .map((ownership) => ownership.site_id)
      .filter((id) => !directIds.has(id));
    let memberSites: typeof directSites = [];
    if (ownedIds.length) {
      const { data, error } = await baseQuery().in('id', ownedIds);
      if (error) throw error;
      memberSites = data;
    }
    return NextResponse.json({
      success: true,
      sites: [...(directSites ?? []), ...(memberSites ?? [])].slice(0, 100),
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { success: false, error: { code: 'invalid_parameters', message: 'Invalid site ID' } },
        { status: 400 },
      );
    }
    console.error('[Visitor Sites] Site retrieval failed:', error);
    return NextResponse.json(
      { success: false, error: { code: 'sites_fetch_error', message: 'Error fetching sites' } },
      { status: 500 },
    );
  }
}
