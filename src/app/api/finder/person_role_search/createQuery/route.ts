import { NextRequest, NextResponse } from 'next/server';
import { CreditService } from '@/lib/services/billing/CreditService';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { logError, logInfo } from '@/lib/utils/api-response-utils';
import { isValidUUID } from '@/lib/agentbase/utils/UuidUtils';
import { authorizeFinderCreate, requireFinderActor, finderFailure, FinderError } from '@/lib/services/finder/ownership';

type AnyRecord = Record<string, unknown>;

function normalizePage(value: unknown): unknown {
  if (typeof value === 'number') return Math.max(0, Math.trunc(value));
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    const n = parseInt(value, 10);
    return Math.max(0, n);
  }
  return value;
}

export async function POST(req: NextRequest) {
  let requestBody: unknown;
  try {
    const { client, userId } = await requireFinderActor(req);
    try { requestBody = await req.json(); } catch { throw new FinderError(400, 'Invalid JSON body.'); }

    if (!requestBody || typeof requestBody !== 'object' || Array.isArray(requestBody)) {
      return NextResponse.json(
        { error: 'Invalid body. Expected JSON object.' },
        { status: 400 }
      );
    }

    // Allow two shapes:
    // 1) { site_id: string, query: {...forager search params...} }
    // 2) { site_id: string, ...forager search params... }
    const bodyObj = requestBody as AnyRecord;
    const siteId = (bodyObj.site_id as string) || '';
    if (!siteId || typeof siteId !== 'string' || !isValidUUID(siteId)) {
      return NextResponse.json(
        { error: 'Missing or invalid site_id' },
        { status: 400 }
      );
    }

    // Optional segment_id association
    let segmentId: string | undefined;
    if ('segment_id' in bodyObj) {
      if (typeof bodyObj.segment_id !== 'string') {
        return NextResponse.json(
          { error: 'Invalid segment_id. Expected UUID string.' },
          { status: 400 }
        );
      }
      if (!isValidUUID(bodyObj.segment_id as string)) {
        return NextResponse.json(
          { error: 'Invalid segment_id format. Must be UUID.' },
          { status: 400 }
        );
      }
      segmentId = bodyObj.segment_id as string;
    }

    // Optional name for icp_mining identification
    let runName: string | undefined;
    if ('name' in bodyObj) {
      if (typeof bodyObj.name !== 'string') {
        return NextResponse.json(
          { error: 'Invalid name. Expected string.' },
          { status: 400 }
        );
      }
      const trimmed = bodyObj.name.trim();
      if (trimmed.length === 0) {
        return NextResponse.json(
          { error: 'Invalid name. Must be non-empty.' },
          { status: 400 }
        );
      }
      runName = trimmed;
    }

    // Optional total_targets for icp_mining
    let totalTargets: number | undefined;
    if ('total_targets' in bodyObj) {
      if (typeof bodyObj.total_targets !== 'number' || !Number.isInteger(bodyObj.total_targets) || bodyObj.total_targets < 0) {
        return NextResponse.json(
          { error: 'Invalid total_targets. Expected non-negative integer.' },
          { status: 400 }
        );
      }
      totalTargets = bodyObj.total_targets;
    }

    let rawQuery: unknown = 'query' in bodyObj ? bodyObj.query : { ...bodyObj };
    if (!rawQuery || typeof rawQuery !== 'object' || Array.isArray(rawQuery)) {
      throw new FinderError(400, 'Missing or invalid query payload');
    }
    const cleanQuery = { ...(rawQuery as AnyRecord) };
    for (const key of ['site_id', 'segment_id', 'name', 'total_targets', 'user_id', 'created_by', 'owner_id', 'icp_criteria']) delete cleanQuery[key];
    rawQuery = cleanQuery;

    // Normalize query minimally to mirror person_role_search route behavior (page can be 0-indexed)
    if (rawQuery && typeof rawQuery === 'object') {
      const obj = { ...(rawQuery as AnyRecord) };
      if ('page' in obj) obj.page = normalizePage((obj as AnyRecord).page);
      rawQuery = obj;
    }

    if (!rawQuery || typeof rawQuery !== 'object') {
      return NextResponse.json(
        { error: 'Missing or invalid query payload' },
        { status: 400 }
      );
    }

    await authorizeFinderCreate(client, siteId, userId, segmentId);
    try {
      const credits = CreditService.PRICING.PERSON_ROLE_SEARCH;
      if (!await CreditService.validateCredits(siteId, credits)) {
        throw new FinderError(402, 'Insufficient credits for role search.');
      }
      await CreditService.deductCredits(siteId, credits, 'person_role_search_query',
        'Person role search query', { query: rawQuery, user_id: userId });
    } catch (error) {
      if (error instanceof FinderError) throw error;
      throw new FinderError(402, 'Credit deduction failed.');
    }

    logInfo('finder.person_role_search.createQuery', 'Upserting role_query', { siteId });

    // Upsert role_query by query_hash (generated column in DB)
    const { data: roleQuery, error: roleQueryErr } = await supabaseAdmin
      .from('role_queries')
      .upsert([{ query: rawQuery as AnyRecord }], { onConflict: 'query_hash' })
      .select('id, query, query_hash, status, created_at, updated_at')
      .single();

    if (roleQueryErr || !roleQuery) {
      logError('finder.person_role_search.createQuery', 'Failed to upsert role_queries', roleQueryErr || {});
      return NextResponse.json(
        { error: 'Database error upserting role_query' },
        { status: 500 }
      );
    }

    // Link role_query to segment if provided (idempotent)
    if (segmentId) {
      const { error: linkErr } = await supabaseAdmin
        .from('role_query_segments')
        .upsert(
          [{ role_query_id: roleQuery.id, segment_id: segmentId }],
          { onConflict: 'role_query_id,segment_id' }
        );
      if (linkErr) {
        logError('finder.person_role_search.createQuery', 'Failed to upsert role_query_segments', linkErr);
        return NextResponse.json(
          { error: 'Database error linking role_query to segment' },
          { status: 500 }
        );
      }
    }

    // Prepare icp_criteria embedding site context and the search snapshot
    const icpCriteria = {
      site_id: siteId,
      user_id: userId,
      source: 'person_role_search',
      query_snapshot: roleQuery.query || rawQuery,
      ...(runName ? { name: runName } : {})
    } as AnyRecord;

    // Compare jsonb directly: JSON.stringify hashes differ from PostgreSQL jsonb::text.
    // The generated DB hash (including user_id) still enforces active uniqueness.
    // Check for existing active icp_mining run for same role_query + criteria
    const { data: existingActiveList, error: existingActiveErr } = await supabaseAdmin
      .from('icp_mining')
      .select('id, status')
      .eq('role_query_id', roleQuery.id)
      .eq('icp_criteria', JSON.stringify(icpCriteria))
      .eq('site_id', siteId)
      .eq('user_id', userId)
      .in('status', ['pending', 'running'])
      .limit(1);

    if (existingActiveErr) {
      logError('finder.person_role_search.createQuery', 'Failed to check existing icp_mining', existingActiveErr);
      return NextResponse.json(
        { error: 'Database error checking icp_mining' },
        { status: 500 }
      );
    }

    const existingActive = Array.isArray(existingActiveList) && existingActiveList.length > 0
      ? existingActiveList[0]
      : null;

    if (existingActive) {
      return NextResponse.json({
        role_query: { id: roleQuery.id, query_hash: roleQuery.query_hash },
        icp_mining: { 
          id: existingActive.id, 
          status: existingActive.status, 
          total_targets: totalTargets ?? 0,
          reused: true 
        }
      });
    }

    // Insert new icp_mining run (status defaults to pending)
    const { data: miningRow, error: miningErr } = await supabaseAdmin
      .from('icp_mining')
      .insert([{ 
        role_query_id: roleQuery.id, 
        icp_criteria: icpCriteria, 
        site_id: siteId, 
        user_id: userId,
        name: runName ?? null,
        total_targets: totalTargets ?? 0
      }])
      .select('id, status, icp_hash, created_at, site_id, name, total_targets')
      .single();

    if (miningErr && (miningErr as unknown as { code?: string }).code === '23505') {
      // Unique violation due to race; fetch the active row
      const { data: racedList } = await supabaseAdmin
        .from('icp_mining')
        .select('id, status')
        .eq('role_query_id', roleQuery.id)
        .eq('icp_criteria', JSON.stringify(icpCriteria))
        .eq('site_id', siteId)
        .eq('user_id', userId)
        .in('status', ['pending', 'running'])
        .limit(1);
      const raced = Array.isArray(racedList) && racedList.length > 0 ? racedList[0] : null;
      if (raced) {
        return NextResponse.json({
          role_query: { id: roleQuery.id, query_hash: roleQuery.query_hash },
          icp_mining: { 
            id: raced.id, 
            status: raced.status, 
            total_targets: totalTargets ?? 0,
            reused: true 
          }
        });
      }
    }

    if (miningErr || !miningRow) {
      logError('finder.person_role_search.createQuery', 'Failed to insert icp_mining', miningErr || {});
      return NextResponse.json(
        { error: 'Database error creating icp_mining' },
        { status: 500 }
      );
    }

    return NextResponse.json({
      role_query: { id: roleQuery.id, query_hash: roleQuery.query_hash },
      icp_mining: { 
        id: miningRow.id, 
        status: miningRow.status, 
        total_targets: miningRow.total_targets,
        reused: false 
      }
    });
  } catch (error: unknown) {
    return finderFailure(error);
  }
}

export const dynamic = 'force-dynamic';


