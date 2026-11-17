import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { logError, logInfo } from '@/lib/utils/api-response-utils';
import { isValidUUID } from '@/lib/agentbase/utils/UuidUtils';
import { requireFinderActor, requireFinderPermission, finderFailure, FinderError } from '@/lib/services/finder/ownership';

type AnyRecord = Record<string, unknown>;

export async function GET(req: NextRequest) {
  try {
    const { client } = await requireFinderActor(req);
    const url = new URL(req.url);
    const icpId = url.searchParams.get('icp_id') || '';
    const siteId = url.searchParams.get('site_id') || '';

    if (!icpId || !isValidUUID(icpId)) {
      return NextResponse.json(
        { error: 'Missing or invalid icp_id (UUID required).' },
        { status: 400 }
      );
    }
    if (siteId && !isValidUUID(siteId)) {
      return NextResponse.json(
        { error: 'Invalid site_id (UUID required if provided).' },
        { status: 400 }
      );
    }

    logInfo('finder.icp.load', 'Fetching icp_mining and role_query', { icpId, siteId: siteId || undefined });

    // Fetch icp_mining row
    let miningQuery = client
      .from('icp_mining')
      .select('id, role_query_id, site_id, name, status, created_at, updated_at')
      .eq('id', icpId)
      .limit(1);

    if (siteId) {
      miningQuery = miningQuery.eq('site_id', siteId);
    }

    const { data: miningRows, error: miningErr } = await miningQuery;
    if (miningErr) {
      logError('finder.icp.load', 'Failed to fetch icp_mining', miningErr);
      return NextResponse.json(
        { error: 'Finder data is unavailable.' },
        { status: 500 }
      );
    }

    const mining = Array.isArray(miningRows) && miningRows.length > 0 ? miningRows[0] as AnyRecord : null;
    if (!mining) {
      return NextResponse.json(
        { error: 'icp_mining not found' },
        { status: 404 }
      );
    }

    const roleQueryId = mining.role_query_id as string | undefined;
    if (!roleQueryId || !isValidUUID(roleQueryId)) {
      return NextResponse.json(
        { error: 'Invalid role_query_id on icp_mining record' },
        { status: 500 }
      );
    }

    // Fetch role_query
    const { data: roleQuery, error: rqErr } = await supabaseAdmin
      .from('role_queries')
      .select('id, query, query_hash, status, created_at, updated_at')
      .eq('id', roleQueryId)
      .single();

    if (rqErr || !roleQuery) {
      logError('finder.icp.load', 'Failed to fetch role_query', rqErr || {});
      return NextResponse.json(
        { error: 'Finder data is unavailable.' },
        { status: 500 }
      );
    }

    return NextResponse.json({
      icp_mining: {
        id: mining.id,
        site_id: mining.site_id,
        name: mining.name,
        status: mining.status,
        created_at: mining.created_at,
        updated_at: mining.updated_at
      },
      role_query: {
        id: roleQuery.id,
        query: roleQuery.query,
        query_hash: roleQuery.query_hash,
        status: roleQuery.status,
        created_at: roleQuery.created_at,
        updated_at: roleQuery.updated_at
      }
    });
  } catch (error: unknown) {
    return finderFailure(error);
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const { client } = await requireFinderActor(req);
    const url = new URL(req.url);
    const icpId = url.searchParams.get('icp_id') || '';
    const siteId = url.searchParams.get('site_id') || '';
    if (!isValidUUID(icpId) || (siteId && !isValidUUID(siteId))) {
      throw new FinderError(400, 'Provide valid icp_id and optional site_id UUIDs.');
    }
    let query = client.from('icp_mining').select('id, site_id').eq('id', icpId);
    if (siteId) query = query.eq('site_id', siteId);
    const { data: mining, error } = await query.maybeSingle();
    if (error) throw new FinderError(503, 'Finder authorization is unavailable.');
    if (!mining?.site_id) throw new FinderError(404, 'icp_mining not found');
    await requireFinderPermission(client, mining.site_id, 'delete');
    // Execute through RLS too: preserves operation-specific/location guards and
    // rechecks visibility at mutation time instead of a service-role TOCTOU bypass.
    const { data: deleted, error: deleteError } = await client.from('icp_mining')
      .delete().eq('id', icpId).eq('site_id', mining.site_id).select('id');
    if (deleteError) throw new FinderError(500, 'Finder list could not be deleted.');
    if (!deleted?.length) throw new FinderError(403, 'Finder deletion is not permitted.');
    return NextResponse.json({ success: true, icp_id: icpId });
  } catch (error) {
    return finderFailure(error);
  }
}

export const dynamic = 'force-dynamic';


