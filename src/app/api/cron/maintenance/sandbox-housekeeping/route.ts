import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { Sandbox } from '@vercel/sandbox';
import { deleteSnapshotQuiet } from '@/lib/services/sandbox-persisted-snapshot';
import { getSandboxHandle } from '@/lib/services/sandbox-sdk';

export const maxDuration = 300;
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const authHeader = request.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return new NextResponse('Unauthorized', { status: 401 });
  }

  const vercelToken = process.env.VERCEL_TOKEN || process.env.VERCEL_API_TOKEN;
  if (!vercelToken) {
    return new NextResponse('VERCEL_TOKEN not set', { status: 500 });
  }
  
  const projectId = process.env.VERCEL_PROJECT_ID;
  const teamId = process.env.VERCEL_TEAM_ID;
  if (!projectId) {
    return new NextResponse('VERCEL_PROJECT_ID not set', { status: 500 });
  }
  if (!teamId) {
    return new NextResponse('VERCEL_TEAM_ID not set', { status: 500 });
  }

  // @vercel/sandbox getCredentials is all-or-nothing: passing projectId/teamId
  // without token throws "Missing credentials parameters ... token".
  const credentials = { token: vercelToken, projectId, teamId };

  try {
    const results = {
      sandboxesStopped: 0,
      sandboxErrors: 0,
      snapshotsDeleted: 0,
      snapshotErrors: 0,
    };

    console.log('[SandboxHousekeeping] Starting orphan cleanup...');

    // 1. Fetch active references from requirement_status
    // Limit to recent records as older ones should have been cleaned up already
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    
    // We only need the actual IDs in use
    const { data: statusRows, error: dbError } = await supabaseAdmin
      .from('requirement_status')
      .select('active_sandbox_id, snapshot_id')
      .gte('created_at', thirtyDaysAgo);

    if (dbError) {
      console.error('[SandboxHousekeeping] Failed to fetch requirement_status:', dbError);
      return new NextResponse('Database Error', { status: 500 });
    }

    const activeSandboxIds = new Set<string>();
    const activeSnapshotIds = new Set<string>();

    for (const row of statusRows || []) {
      if (row.active_sandbox_id) activeSandboxIds.add(row.active_sandbox_id);
      if (row.snapshot_id) activeSnapshotIds.add(row.snapshot_id);
    }

    // 2. Fetch all running sandboxes
    console.log(`[SandboxHousekeeping] Fetched ${activeSandboxIds.size} active sandbox IDs and ${activeSnapshotIds.size} active snapshot IDs from DB.`);
    
    const thirtyMinutesAgo = Date.now() - 30 * 60 * 1000;

    const listed = await listHousekeepingSandboxes(credentials);
    for (const sb of listed) {
      const id = sb.id || sb.name;
      if (!id) continue;
      const isActive = activeSandboxIds.has(sb.id) || (sb.name ? activeSandboxIds.has(sb.name) : false);
      if (isActive) continue;
      const createdAt = sb.createdAt ? new Date(sb.createdAt).getTime() : 0;
      if (createdAt && createdAt >= thirtyMinutesAgo) continue;
      console.log(`[SandboxHousekeeping] Stopping orphaned sandbox ${id} (created ${createdAt ? new Date(createdAt).toISOString() : 'unknown'})`);
      try {
        const sandboxInstance = await getSandboxHandle(id);
        await Promise.race([
          sandboxInstance.stop({ blocking: false }),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 5000))
        ]);
        results.sandboxesStopped++;
      } catch (stopErr: unknown) {
        console.warn(`[SandboxHousekeeping] Failed to stop sandbox ${id}:`, stopErr instanceof Error ? stopErr.message : stopErr);
        results.sandboxErrors++;
      }
    }

    // 3. Clean up orphaned snapshots (SDK Snapshot.list when present, else REST)
    const twentyFourHoursAgo = Date.now() - 24 * 60 * 60 * 1000;
    const sdkSnaps = await listSnapshotsViaSdk(credentials);
    if (sdkSnaps.length) {
      for (const snap of sdkSnaps) {
        if (!snap.id || activeSnapshotIds.has(snap.id)) continue;
        const createdAt = snap.createdAt ? new Date(snap.createdAt).getTime() : 0;
        if (createdAt && createdAt >= twentyFourHoursAgo) continue;
        try {
          await deleteSnapshotQuiet(snap.id);
          results.snapshotsDeleted++;
        } catch {
          results.snapshotErrors++;
        }
      }
    } else {
    
    try {
      let next: string | undefined = undefined;
      let hasMoreSnapshots = true;
      let pages = 0;

      while (hasMoreSnapshots && pages < 100) {
        pages++;
        const url = new URL(`https://api.vercel.com/v1/sandboxes/snapshots`);
        // The API parameter is 'project', not 'projectId'
        url.searchParams.append('project', projectId);
        if (teamId) url.searchParams.append('teamId', teamId);
        if (next) url.searchParams.append('until', next);
        
        const snapRes = await fetch(url.toString(), {
          headers: { Authorization: `Bearer ${vercelToken}` },
        });
        
        if (snapRes.ok) {
          const snapshotsResult = await snapRes.json();
          const snapshots = snapshotsResult.snapshots || [];
          
          if (!snapshots.length) break;
          
          let added = 0;
          for (const snap of snapshots) {
            added++;
            // Skip already deleted snapshots
            if (snap.status === 'deleted') continue;

            if (!activeSnapshotIds.has(snap.id)) {
              const createdAt = new Date(snap.createdAt).getTime();
              if (createdAt < twentyFourHoursAgo) {
                console.log(`[SandboxHousekeeping] Deleting orphaned snapshot ${snap.id} (created ${new Date(createdAt).toISOString()})`);
                try {
                  await deleteSnapshotQuiet(snap.id);
                  results.snapshotsDeleted++;
                } catch (delErr: unknown) {
                  console.warn(`[SandboxHousekeeping] Failed to delete snapshot ${snap.id}:`, delErr instanceof Error ? delErr.message : delErr);
                  results.snapshotErrors++;
                }
              }
            }
          }
          
          if (!snapshotsResult.pagination?.next || added === 0) {
            hasMoreSnapshots = false;
          } else {
            next = String(snapshotsResult.pagination.next);
          }
        } else {
          console.warn(`[SandboxHousekeeping] Failed to list snapshots from Vercel API: ${snapRes.status} ${await snapRes.text()}`);
          break;
        }
      }
    } catch (e: unknown) {
      console.error('[SandboxHousekeeping] Error processing snapshots:', e);
    }
    }

    console.log('[SandboxHousekeeping] Cleanup complete.', results);
    return NextResponse.json({ success: true, results });
  } catch (error: any) {
    console.error('[SandboxHousekeeping] Unhandled error:', error);
    return new NextResponse(`Internal Error: ${error.message}`, { status: 500 });
  }
}

type ListedSandbox = { id: string; name?: string; createdAt?: string | number };

async function listHousekeepingSandboxes(
  credentials: { token: string; projectId: string; teamId: string },
): Promise<ListedSandbox[]> {
  const out: ListedSandbox[] = [];
  const listFn = Sandbox.list.bind(Sandbox) as (opts: Record<string, unknown>) => Promise<unknown>;

  let tagged: ListedSandbox[] = [];
  try {
    const taggedList = await listFn({ ...credentials, tags: { kind: 'requirement' } });
    tagged = collectListedSandboxes(taggedList);
  } catch {
    /* v1 list does not accept tags */
  }

  let until: number | undefined;
  for (let page = 0; page < 100; page++) {
    let list: unknown;
    try {
      list = await listFn({ ...credentials, ...(until ? { until } : {}) });
    } catch (e: unknown) {
      console.error('[SandboxHousekeeping] Failed to list sandboxes:', e);
      break;
    }
    const pageItems = collectListedSandboxes(list);
    out.push(...pageItems);
    const next = paginationNext(list);
    if (!next || pageItems.length === 0) break;
    until = next;
  }

  const seen = new Map<string, ListedSandbox>();
  for (const row of out) seen.set(row.id, row);
  for (const row of tagged) {
    if (!seen.has(row.id)) seen.set(row.id, row);
  }
  return Array.from(seen.values());
}

function collectListedSandboxes(list: unknown): ListedSandbox[] {
  if (!list) return [];
  const rec = list as {
    json?: { sandboxes?: Array<{ id?: string; name?: string; createdAt?: string | number }> };
    sandboxes?: Array<{ id?: string; name?: string; createdAt?: string | number }>;
  };
  const rows = rec.json?.sandboxes ?? rec.sandboxes ?? [];
  return rows
    .filter((sb): sb is { id: string; name?: string; createdAt?: string | number } => !!sb.id)
    .map((sb) => ({ id: sb.id, name: sb.name, createdAt: sb.createdAt }));
}

function paginationNext(list: unknown): number | undefined {
  const rec = list as { json?: { pagination?: { next?: number } }; pagination?: { next?: number } };
  return rec.json?.pagination?.next ?? rec.pagination?.next;
}

async function listSnapshotsViaSdk(
  credentials: { token: string; projectId: string; teamId: string },
): Promise<Array<{ id: string; createdAt?: string }>> {
  const snapApi = (Sandbox as unknown as {
    listSnapshots?: (opts: Record<string, unknown>) => Promise<{ snapshots?: Array<{ id?: string; createdAt?: string }> }>;
  }).listSnapshots;
  if (typeof snapApi !== 'function') return [];
  try {
    const res = await snapApi({ ...credentials });
    return (res.snapshots || []).filter((s): s is { id: string; createdAt?: string } => !!s.id);
  } catch {
    return [];
  }
}
