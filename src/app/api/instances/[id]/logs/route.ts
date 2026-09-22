import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { createInstanceLogCore } from '@/app/api/agents/tools/instance_logs/route';
import { readLiveInstanceLogSnapshots } from '@/lib/services/robot-instance/assistant-streaming-logs';
import { canAccessSite } from '@/lib/security/site-access';
import {
  readRedisJson,
  writeRedisJson,
} from '@/lib/services/redis-json-cache';

// ------------------------------------------------------------------------------------
// GET /api/instances/[id]/logs
// Retrieves logs for a specific instance, with optional pagination and filtering
// ------------------------------------------------------------------------------------

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

    if (!id) {
      return NextResponse.json(
        { error: 'El parámetro id es requerido' },
        { status: 400 }
      );
    }

    const { searchParams } = new URL(request.url);
    const liveOnly = searchParams.get('live_only') === 'true';
    const limit = parseInt(searchParams.get('limit') || '50', 10);
    const offset = parseInt(searchParams.get('offset') || '0', 10);
    const logType = searchParams.get('log_type');
    const level = searchParams.get('level');

    const instanceCacheKey = `cache:instance-site:${id}`;
    let instance = await readRedisJson<{ id: string; site_id: string }>(
      instanceCacheKey,
    );
    let instanceError: unknown = null;
    if (!instance) {
      const result = await supabaseAdmin
        .from('remote_instances')
        .select('id, site_id')
        .eq('id', id)
        .single();
      instance = result.data;
      instanceError = result.error;
      if (instance) await writeRedisJson(instanceCacheKey, instance, 60);
    }

    if (instanceError || !instance) {
      return NextResponse.json(
        { error: 'Instancia no encontrada' },
        { status: 404 }
      );
    }
    if (!await canAccessSite(request, instance.site_id)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    if (liveOnly) {
      const logs = (await readLiveInstanceLogSnapshots(id))
        .filter((snapshot) => !logType || snapshot.log_type === logType)
        .filter((snapshot) => !level || snapshot.level === level)
        .sort(
          (a, b) =>
            new Date(b.created_at).getTime()
            - new Date(a.created_at).getTime(),
        );
      return NextResponse.json({ logs, live: true }, { status: 200 });
    }

    // Query logs
    let query = supabaseAdmin
      .from('instance_logs')
      .select('*')
      .eq('instance_id', id)
      .order('created_at', { ascending: false });

    if (logType) {
      query = query.eq('log_type', logType);
    }
    if (level) {
      query = query.eq('level', level);
    }

    const { data: logs, error: logsError } = await query
      .range(offset, offset + limit - 1);

    if (logsError) {
      console.error('Error fetching logs:', logsError.message);
      return NextResponse.json(
        { error: 'Error al obtener los logs' },
        { status: 500 }
      );
    }

    const mergedById = new Map(
      (logs || []).map((log) => [String(log.id), log]),
    );
    if (offset === 0) {
      const liveSnapshots = await readLiveInstanceLogSnapshots(id);
      for (const snapshot of liveSnapshots) {
        if (logType && snapshot.log_type !== logType) continue;
        if (level && snapshot.level !== level) continue;
        const existing = mergedById.get(snapshot.id);
        mergedById.set(
          snapshot.id,
          existing
            ? {
              ...existing,
              message: snapshot.message,
              updated_at: snapshot.updated_at,
            }
            : snapshot,
        );
      }
    }
    const mergedLogs = Array.from(mergedById.values()).sort(
      (a, b) =>
        new Date(b.created_at).getTime()
        - new Date(a.created_at).getTime(),
    );

    return NextResponse.json(
      { logs: mergedLogs.slice(0, limit), limit, offset },
      { status: 200 },
    );
  } catch (err: any) {
    console.error('Error in GET /api/instances/[id]/logs:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

// ------------------------------------------------------------------------------------
// POST /api/instances/[id]/logs
// Creates a new log for the instance
// ------------------------------------------------------------------------------------

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    if (!id) return NextResponse.json({ error: 'id requerido' }, { status: 400 });

    const payload = await request.json();
    const instanceCacheKey = `cache:instance-site:${id}`;
    let instance = await readRedisJson<{ id: string; site_id: string }>(
      instanceCacheKey,
    );
    if (!instance) {
      const { data, error } = await supabaseAdmin
        .from('remote_instances')
        .select('id, site_id')
        .eq('id', id)
        .single();
      if (error || !data) {
        return NextResponse.json(
          { error: 'Instancia no encontrada' },
          { status: 404 }
        );
      }
      instance = data;
      await writeRedisJson(instanceCacheKey, instance, 60);
    }
    if (!await canAccessSite(request, instance.site_id)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const result = await createInstanceLogCore({
      ...payload,
      instance_id: id,
      site_id: instance.site_id,
    });

    return NextResponse.json({ log: result.data, message: 'Log creado correctamente' }, { status: 201 });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
