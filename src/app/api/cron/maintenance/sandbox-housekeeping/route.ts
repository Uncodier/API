import { NextResponse } from 'next/server';
import { Sandbox } from '@vercel/sandbox';
import { deleteSnapshotQuiet } from '@/lib/services/sandbox-persisted-snapshot';
import { stopSandboxQuiet } from '@/lib/services/sandbox-stop';
import { reconcileSandboxBilling, retireSandboxBilling } from '@/lib/services/billing/sandbox-billing';
import { isSandboxNotFoundError } from '@/lib/services/sandbox-missing-snapshot';
import { listHousekeepingSandboxes } from '@/lib/services/billing/sandbox-housekeeping-list';
import { housekeepingRows } from '@/lib/services/billing/sandbox-housekeeping-db';
import { sandboxSdkMajor } from '@/lib/services/sandbox-sdk';
import { deleteSandboxAndOrphans } from '@/lib/services/sandbox-lifecycle';

export const maxDuration = 300;
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const authHeader = request.headers.get('authorization');
  if (!process.env.CRON_SECRET || authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
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
      sandboxesBilled: 0,
      billingErrors: 0,
    };

    console.log('[SandboxHousekeeping] Starting orphan cleanup...');

    // 1. Fetch active references from requirement_status
    // Limit to recent records as older ones should have been cleaned up already
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    
    // We only need the actual IDs in use
    const statusRows = await housekeepingRows('requirement_status','active_sandbox_id, snapshot_id','id',thirtyDaysAgo);

    const activeSandboxIds = new Set<string>();
    const activeSnapshotIds = new Set<string>();

    for (const row of statusRows || []) {
      if (row.active_sandbox_id) activeSandboxIds.add(row.active_sandbox_id);
      if (row.snapshot_id) activeSnapshotIds.add(row.snapshot_id);
    }
    // Portable harness workspaces are absent from legacy requirement_status.
    const harnessRows = await housekeepingRows('harness_sessions','snapshot');
    for (const row of harnessRows || []) {
      const snapshot = row.snapshot as { status?: string; workspace?: { id?: string } };
      if (!['completed', 'cancelled', 'failed'].includes(snapshot.status || '') && snapshot.workspace?.id) activeSandboxIds.add(snapshot.workspace.id);
    }
    const workflowRows = await housekeepingRows('instance_plans','metadata,status');
    for (const row of workflowRows) {
      if (!['completed','cancelled','failed'].includes(row.status) && row.metadata?.active_sandbox_id) activeSandboxIds.add(row.metadata.active_sandbox_id);
    }

    // 2. Fetch all running sandboxes
    console.log(`[SandboxHousekeeping] Fetched ${activeSandboxIds.size} active sandbox IDs and ${activeSnapshotIds.size} active snapshot IDs from DB.`);
    
    const thirtyMinutesAgo = Date.now() - 30 * 60 * 1000;

    const listed = await listHousekeepingSandboxes(credentials);
    // Reconcile ALL registered resources, including stopped sessions after auto
    // timeout and resources omitted from a provider list page. No implicit resume.
    const tracked = await housekeepingRows('sandbox_billing_resources','sandbox_name,deletion_requested_at','sandbox_name',undefined,true);
    for (const row of tracked || []) {
      let sandbox: Sandbox | undefined;
      try {
        sandbox = await Sandbox.get({ ...credentials, name: row.sandbox_name, resume: false });
        if (sandbox.currentSnapshotId) activeSnapshotIds.add(sandbox.currentSnapshotId);
        await reconcileSandboxBilling(sandbox);
        if (row.deletion_requested_at) await deleteSandboxAndOrphans(row.sandbox_name);
        results.sandboxesBilled++;
      } catch (error) {
        if (!sandbox && isSandboxNotFoundError(error)) {
          try { await retireSandboxBilling(row.sandbox_name,'finish'); continue; } catch { /* Unproven disappearance remains pending. */ }
        }
        results.billingErrors++;
        // A known unpaid/outage interval must not authorize more running time.
        if (sandbox && ['running', 'pending', 'snapshotting', 'stopping'].includes(sandbox.status)) await stopSandboxQuiet(sandbox);
      }
    }
    // Preserve restore points even for not-yet-registered persistent workspaces.
    // Any failed lookup aborts destructive snapshot cleanup rather than guessing.
    for (const name of activeSandboxIds) {
      if (tracked.some(row => row.sandbox_name === name)) continue;
      const active = await Sandbox.get({ ...credentials, name, resume:false });
      if (active.currentSnapshotId) activeSnapshotIds.add(active.currentSnapshotId);
    }
    for (const sb of listed) {
      const id = sb.id || sb.name;
      if (!id) continue;
      const isActive = activeSandboxIds.has(sb.id) || (sb.name ? activeSandboxIds.has(sb.name) : false);
      if (isActive) continue;
      const createdAt = sb.createdAt ? new Date(sb.createdAt).getTime() : 0;
      if (createdAt && createdAt >= thirtyMinutesAgo) continue;
      console.log(`[SandboxHousekeeping] Stopping orphaned sandbox ${id} (created ${createdAt ? new Date(createdAt).toISOString() : 'unknown'})`);
      try {
        const sandboxInstance = await Sandbox.get({ ...credentials, name: id, resume: false });
        const stopped = await stopSandboxQuiet(sandboxInstance);
        if (stopped) results.sandboxesStopped++;
        else results.sandboxErrors++;
      } catch (stopErr: unknown) {
        console.warn('[SandboxHousekeeping] Sandbox stop failed; cleanup remains pending.');
        results.sandboxErrors++;
      }
    }

    // v3 owns persistent restore snapshots via keepLastSnapshots. A global list
    // cannot reliably prove ownership, so do not delete paused/new stop snapshots.
    if (sandboxSdkMajor() >= 3) return NextResponse.json({ success:results.billingErrors === 0, results });

    // 3. Clean up legacy orphaned snapshots (SDK Snapshot.list when present, else REST)
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
                  console.warn('[SandboxHousekeeping] Snapshot deletion failed.');
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
          console.warn(`[SandboxHousekeeping] Failed to list snapshots (HTTP ${snapRes.status}).`);
          break;
        }
      }
    } catch (e: unknown) {
      console.error('[SandboxHousekeeping] Snapshot processing failed.');
    }
    }

    console.log('[SandboxHousekeeping] Cleanup complete.', results);
    return NextResponse.json({ success: true, results });
  } catch {
    console.error('[SandboxHousekeeping] Reconciliation failed; cleanup will retry.');
    return new NextResponse('Sandbox housekeeping unavailable', { status: 500 });
  }
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
