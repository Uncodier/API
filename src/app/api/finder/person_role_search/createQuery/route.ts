import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { logError, logInfo } from '@/lib/utils/api-response-utils';
import crypto from 'crypto';

type AnyRecord = Record<string, unknown>;

function normalizePage(value: unknown): unknown {
  if (typeof value === 'number') return Math.max(0, Math.trunc(value));
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    const n = parseInt(value, 10);
    return Math.max(0, n);
  }
  return value;
}

function computeSha256Hex(obj: unknown): string {
  const json = JSON.stringify(obj);
  return crypto.createHash('sha256').update(json).digest('hex');
}

export async function POST(req: NextRequest) {
  let requestBody: unknown;
  try {
    requestBody = await req.json();

    if (!requestBody || typeof requestBody !== 'object') {
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
    if (!siteId || typeof siteId !== 'string') {
      return NextResponse.json(
        { error: 'Missing or invalid site_id' },
        { status: 400 }
      );
    }

    let rawQuery: unknown = 'query' in bodyObj ? bodyObj.query : { ...bodyObj };
    if (rawQuery && typeof rawQuery === 'object' && 'site_id' in (rawQuery as AnyRecord)) {
      const { site_id: _omit, ...rest } = rawQuery as AnyRecord;
      rawQuery = rest;
    }

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
        { error: 'Database error upserting role_query', details: roleQueryErr?.message || roleQueryErr },
        { status: 500 }
      );
    }

    // Prepare icp_criteria embedding site context and the search snapshot
    const icpCriteria = {
      site_id: siteId,
      source: 'person_role_search',
      query_snapshot: roleQuery.query || rawQuery
    } as AnyRecord;

    const icpHash = computeSha256Hex(icpCriteria);

    // Check for existing active icp_mining run for same role_query + criteria
    const { data: existingActiveList, error: existingActiveErr } = await supabaseAdmin
      .from('icp_mining')
      .select('id, status')
      .eq('role_query_id', roleQuery.id)
      .eq('icp_hash', icpHash)
      .in('status', ['pending', 'running'])
      .limit(1);

    if (existingActiveErr) {
      logError('finder.person_role_search.createQuery', 'Failed to check existing icp_mining', existingActiveErr);
      return NextResponse.json(
        { error: 'Database error checking icp_mining', details: existingActiveErr.message },
        { status: 500 }
      );
    }

    const existingActive = Array.isArray(existingActiveList) && existingActiveList.length > 0
      ? existingActiveList[0]
      : null;

    if (existingActive) {
      return NextResponse.json({
        role_query: { id: roleQuery.id, query_hash: roleQuery.query_hash },
        icp_mining: { id: existingActive.id, status: existingActive.status, reused: true }
      });
    }

    // Insert new icp_mining run (status defaults to pending)
    const { data: miningRow, error: miningErr } = await supabaseAdmin
      .from('icp_mining')
      .insert([{ role_query_id: roleQuery.id, icp_criteria: icpCriteria }])
      .select('id, status, icp_hash, created_at')
      .single();

    if (miningErr && (miningErr as AnyRecord)?.code === '23505') {
      // Unique violation due to race; fetch the active row
      const { data: racedList } = await supabaseAdmin
        .from('icp_mining')
        .select('id, status')
        .eq('role_query_id', roleQuery.id)
        .eq('icp_hash', icpHash)
        .in('status', ['pending', 'running'])
        .limit(1);
      const raced = Array.isArray(racedList) && racedList.length > 0 ? racedList[0] : null;
      if (raced) {
        return NextResponse.json({
          role_query: { id: roleQuery.id, query_hash: roleQuery.query_hash },
          icp_mining: { id: raced.id, status: raced.status, reused: true }
        });
      }
    }

    if (miningErr || !miningRow) {
      logError('finder.person_role_search.createQuery', 'Failed to insert icp_mining', miningErr || {});
      return NextResponse.json(
        { error: 'Database error creating icp_mining', details: miningErr?.message || miningErr },
        { status: 500 }
      );
    }

    return NextResponse.json({
      role_query: { id: roleQuery.id, query_hash: roleQuery.query_hash },
      icp_mining: { id: miningRow.id, status: miningRow.status, reused: false }
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    logError('finder.person_role_search.createQuery', 'Handler exception', error instanceof Error ? { message: error.message, stack: error.stack, body: requestBody } : { error, body: requestBody });
    return NextResponse.json({ error: 'Internal error', message }, { status: 500 });
  }
}

export const dynamic = 'force-dynamic';


