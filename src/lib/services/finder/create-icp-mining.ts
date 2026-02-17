/**
 * Core logic for creating ICP mining runs (Finder)
 * Used by finder createQuery and createIcpMining agent tool
 */

import { supabaseAdmin } from '@/lib/database/supabase-client';
import crypto from 'crypto';
import { isValidUUID } from '@/lib/agentbase/utils/UuidUtils';

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

export interface CreateIcpMiningParams {
  site_id: string;
  query: Record<string, unknown>;
  segment_id?: string;
  name?: string;
  total_targets?: number;
}

export interface CreateIcpMiningResult {
  success: boolean;
  role_query?: { id: string; query_hash: string };
  icp_mining?: {
    id: string;
    status: string;
    total_targets: number;
    reused: boolean;
  };
  error?: string;
  details?: unknown;
}

export async function createIcpMiningCore(
  params: CreateIcpMiningParams
): Promise<CreateIcpMiningResult> {
  const { site_id: siteId, query: rawQueryInput, segment_id: segmentId, name: runName, total_targets: totalTargets } = params;

  if (!siteId || typeof siteId !== 'string') {
    return { success: false, error: 'Missing or invalid site_id' };
  }
  if (!isValidUUID(siteId)) {
    return { success: false, error: 'Invalid site_id format. Must be UUID.' };
  }
  if (segmentId !== undefined && !isValidUUID(segmentId)) {
    return { success: false, error: 'Invalid segment_id format. Must be UUID.' };
  }
  if (runName !== undefined && (typeof runName !== 'string' || runName.trim().length === 0)) {
    return { success: false, error: 'Invalid name. Must be non-empty string.' };
  }
  if (
    totalTargets !== undefined &&
    (typeof totalTargets !== 'number' || !Number.isInteger(totalTargets) || totalTargets < 0)
  ) {
    return { success: false, error: 'Invalid total_targets. Expected non-negative integer.' };
  }
  if (!rawQueryInput || typeof rawQueryInput !== 'object') {
    return { success: false, error: 'Missing or invalid query payload' };
  }

  let rawQuery: AnyRecord = { ...rawQueryInput };
  if ('page' in rawQuery) {
    rawQuery = { ...rawQuery, page: normalizePage(rawQuery.page) };
  }

  const { data: roleQuery, error: roleQueryErr } = await supabaseAdmin
    .from('role_queries')
    .upsert([{ query: rawQuery }], { onConflict: 'query_hash' })
    .select('id, query, query_hash, status, created_at, updated_at')
    .single();

  if (roleQueryErr || !roleQuery) {
    return {
      success: false,
      error: 'Database error upserting role_query',
      details: roleQueryErr?.message || roleQueryErr,
    };
  }

  if (segmentId) {
    const { error: linkErr } = await supabaseAdmin
      .from('role_query_segments')
      .upsert(
        [{ role_query_id: roleQuery.id, segment_id: segmentId }],
        { onConflict: 'role_query_id,segment_id' }
      );
    if (linkErr) {
      return {
        success: false,
        error: 'Database error linking role_query to segment',
        details: linkErr.message,
      };
    }
  }

  const icpCriteria: AnyRecord = {
    site_id: siteId,
    source: 'person_role_search',
    query_snapshot: roleQuery.query || rawQuery,
    ...(runName ? { name: runName } : {}),
  };
  const icpHash = computeSha256Hex(icpCriteria);

  const { data: existingActiveList, error: existingActiveErr } = await supabaseAdmin
    .from('icp_mining')
    .select('id, status')
    .eq('role_query_id', roleQuery.id)
    .eq('icp_hash', icpHash)
    .in('status', ['pending', 'running'])
    .limit(1);

  if (existingActiveErr) {
    return {
      success: false,
      error: 'Database error checking icp_mining',
      details: existingActiveErr.message,
    };
  }

  const existingActive =
    Array.isArray(existingActiveList) && existingActiveList.length > 0
      ? existingActiveList[0]
      : null;

  if (existingActive) {
    return {
      success: true,
      role_query: { id: roleQuery.id, query_hash: roleQuery.query_hash },
      icp_mining: {
        id: existingActive.id,
        status: existingActive.status,
        total_targets: totalTargets ?? 0,
        reused: true,
      },
    };
  }

  const { data: miningRow, error: miningErr } = await supabaseAdmin
    .from('icp_mining')
    .insert([
      {
        role_query_id: roleQuery.id,
        icp_criteria: icpCriteria,
        site_id: siteId,
        name: runName ?? null,
        total_targets: totalTargets ?? 0,
      },
    ])
    .select('id, status, icp_hash, created_at, site_id, name, total_targets')
    .single();

  if (miningErr && (miningErr as unknown as { code?: string }).code === '23505') {
    const { data: racedList } = await supabaseAdmin
      .from('icp_mining')
      .select('id, status')
      .eq('role_query_id', roleQuery.id)
      .eq('icp_hash', icpHash)
      .in('status', ['pending', 'running'])
      .limit(1);
    const raced = Array.isArray(racedList) && racedList.length > 0 ? racedList[0] : null;
    if (raced) {
      return {
        success: true,
        role_query: { id: roleQuery.id, query_hash: roleQuery.query_hash },
        icp_mining: {
          id: raced.id,
          status: raced.status,
          total_targets: totalTargets ?? 0,
          reused: true,
        },
      };
    }
  }

  if (miningErr || !miningRow) {
    return {
      success: false,
      error: 'Database error creating icp_mining',
      details: miningErr?.message || miningErr,
    };
  }

  return {
    success: true,
    role_query: { id: roleQuery.id, query_hash: roleQuery.query_hash },
    icp_mining: {
      id: miningRow.id,
      status: miningRow.status,
      total_targets: miningRow.total_targets,
      reused: false,
    },
  };
}
