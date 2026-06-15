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
    
    let page = 1;
    let hasMore = true;
    const thirtyMinutesAgo = Date.now() - 30 * 60 * 1000;
    
    while (hasMore) {
      // Vercel SDK currently has limited pagination, we'll hit the API directly if needed,
      // but let's try the SDK first (it limits to ~100 by default or handles it internally)
      let list: any;
      try {
        list = await Sandbox.list({ projectId, teamId });
        hasMore = false; // The SDK list() might not paginate well, so we assume 1 page for now
      } catch (e: unknown) {
        console.error('[SandboxHousekeeping] Failed to list sandboxes:', e);
        break;
      }
      
      const sandboxesArray = list?.json?.sandboxes || list?.sandboxes || [];
      for (const sb of sandboxesArray) {
        // Stop sandboxes that are NOT active in DB AND are older than 30 minutes
        if (!activeSandboxIds.has(sb.id)) {
          // createdAt is usually a timestamp. If not available, we assume it's old enough
          // depending on Vercel Sandbox API
          const createdAt = sb.createdAt ? new Date(sb.createdAt).getTime() : 0;
          if (createdAt < thirtyMinutesAgo) {
            console.log(`[SandboxHousekeeping] Stopping orphaned sandbox ${sb.id} (created ${new Date(createdAt).toISOString()})`);
            try {
              const sandboxInstance = await Sandbox.get({ sandboxId: sb.id });
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
    }

    // 3. Clean up orphaned snapshots
    // Since Sandbox.listSnapshots() doesn't exist in the SDK, we use the Vercel API directly
    const twentyFourHoursAgo = Date.now() - 24 * 60 * 60 * 1000;
    
    try {
      const url = new URL(`https://api.vercel.com/v1/sandboxes/snapshots`);
      url.searchParams.append('projectId', projectId);
      if (teamId) url.searchParams.append('teamId', teamId);
      
      const snapRes = await fetch(url.toString(), {
        headers: { Authorization: `Bearer ${vercelToken}` },
      });
      
      if (snapRes.ok) {
        const snapshotsResult = await snapRes.json();
        const snapshots = snapshotsResult.snapshots || [];
        
        for (const snap of snapshots) {
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
      } else {
        console.warn(`[SandboxHousekeeping] Failed to list snapshots from Vercel API: ${snapRes.status} ${await snapRes.text()}`);
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
