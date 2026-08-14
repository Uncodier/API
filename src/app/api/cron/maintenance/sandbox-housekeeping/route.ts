import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { Sandbox } from '@vercel/sandbox';
import { deleteSnapshotQuiet } from '@/lib/services/sandbox-persisted-snapshot';

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
    let until: number | undefined;
    let sandboxPages = 0;

    while (sandboxPages < 100) {
      sandboxPages++;
      let list: Awaited<ReturnType<typeof Sandbox.list>>;
      try {
        list = await Sandbox.list({ ...credentials, ...(until ? { until } : {}) });
      } catch (e: unknown) {
        console.error('[SandboxHousekeeping] Failed to list sandboxes:', e);
        break;
      }

      const sandboxesArray = list.json?.sandboxes ?? [];
      for (const sb of sandboxesArray) {
        if (!activeSandboxIds.has(sb.id)) {
          const createdAt = sb.createdAt ? new Date(sb.createdAt).getTime() : 0;
          if (createdAt < thirtyMinutesAgo) {
            console.log(`[SandboxHousekeeping] Stopping orphaned sandbox ${sb.id} (created ${new Date(createdAt).toISOString()})`);
            try {
              const sandboxInstance = await Sandbox.get({ sandboxId: sb.id, ...credentials });
              await Promise.race([
                sandboxInstance.stop({ blocking: false }),
                new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 5000))
              ]);
              results.sandboxesStopped++;
            } catch (stopErr: unknown) {
              console.warn(`[SandboxHousekeeping] Failed to stop sandbox ${sb.id}:`, stopErr instanceof Error ? stopErr.message : stopErr);
              results.sandboxErrors++;
            }
          }
        }
      }

      const next = list.json?.pagination?.next;
      if (!next || sandboxesArray.length === 0) break;
      until = next;
    }

    // 3. Clean up orphaned snapshots
    // Since Sandbox.listSnapshots() doesn't exist in the SDK, we use the Vercel API directly
    const twentyFourHoursAgo = Date.now() - 24 * 60 * 60 * 1000;
    
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

    console.log('[SandboxHousekeeping] Cleanup complete.', results);
    return NextResponse.json({ success: true, results });
  } catch (error: any) {
    console.error('[SandboxHousekeeping] Unhandled error:', error);
    return new NextResponse(`Internal Error: ${error.message}`, { status: 500 });
  }
}
