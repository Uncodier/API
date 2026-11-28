import { NextResponse } from 'next/server';
import { Sandbox } from '@vercel/sandbox';
import { stopSandboxQuiet } from '@/lib/services/sandbox-stop';
import { reconcileSandboxBilling, retireSandboxBilling, SandboxBillingError } from '@/lib/services/billing/sandbox-billing';
import { isSandboxNotFoundError } from '@/lib/services/sandbox-missing-snapshot';
import { listHousekeepingSandboxes, type HousekeepingCredentials } from '@/lib/services/billing/sandbox-housekeeping-list';
import { housekeepingRows, requirementStatusReferences } from '@/lib/services/billing/sandbox-housekeeping-db';
import { sandboxSdkMajor } from '@/lib/services/sandbox-sdk';
import { claimSandboxCleanup } from '@/lib/services/billing/sandbox-cleanup-fence';
import { withCronObservation } from '@/lib/status/cron-observation';

export const maxDuration = 300;
export const dynamic = 'force-dynamic';

async function runCron(request: Request) {
  const authHeader = request.headers.get('authorization');
  if (!process.env.CRON_SECRET || authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return new NextResponse('Unauthorized', { status: 401 });
  }

  const vercelToken = process.env.VERCEL_TOKEN || process.env.VERCEL_API_TOKEN;
  // On Vercel, let the SDK resolve and refresh its project-scoped OIDC token.
  // Passing a stale personal token overrides that context and can return 403.
  const useOidc = process.env.VERCEL === '1' && sandboxSdkMajor() >= 3;
  if (!useOidc && !vercelToken) {
    return new NextResponse('VERCEL_TOKEN not set', { status: 500 });
  }
  
  const projectId = process.env.VERCEL_PROJECT_ID;
  const teamId = process.env.VERCEL_TEAM_ID;
  if (!useOidc && !projectId) {
    return new NextResponse('VERCEL_PROJECT_ID not set', { status: 500 });
  }
  if (!useOidc && !teamId) {
    return new NextResponse('VERCEL_TEAM_ID not set', { status: 500 });
  }

  // @vercel/sandbox getCredentials is all-or-nothing: passing projectId/teamId
  // without token throws "Missing credentials parameters ... token".
  const credentials: HousekeepingCredentials = useOidc ? {} : { token: vercelToken!, projectId: projectId!, teamId: teamId! };
  let stage = 'references';

  try {
    const results = {
      sandboxesStopped: 0,
      sandboxErrors: 0,
      snapshotsDeleted: 0,
      snapshotErrors: 0,
      sandboxesBilled: 0,
      billingErrors: 0,
      terminalSandboxesDeleted: 0,
      fundingPending: 0,
      missingResources: 0,
      reconciliationPending: 0,
      sandboxesAlreadyStopped: 0,
      unfencedSandboxCandidates: 0,
      deferredDeletionIntents: 0,
    };

    console.log('[SandboxHousekeeping] Starting reconciliation...');

    // 1. Fetch active references from requirement_status
    // Age is not proof that a paused workspace/restore point is disposable.
    const { activeSandboxIds, activeSnapshotIds } = await requirementStatusReferences();
    // Portable harness workspaces are absent from legacy requirement_status.
    const harnessRows = await housekeepingRows('harness_sessions','id,site_id,snapshot');
    for (const row of harnessRows || []) {
      const snapshot = row.snapshot as { status?: string; workspace?: { id?: string } } | null;
      if (!snapshot || typeof snapshot !== 'object') continue;
      if (!['completed', 'cancelled', 'failed'].includes(snapshot.status || '') && snapshot.workspace?.id) activeSandboxIds.add(snapshot.workspace.id);
    }
    const workflowRows = await housekeepingRows('instance_plans','metadata,status');
    for (const row of workflowRows) {
      if (!['completed','cancelled','failed'].includes(row.status) && row.metadata?.active_sandbox_id) activeSandboxIds.add(row.metadata.active_sandbox_id);
    }
    const assistantWorkspaces = await housekeepingRows('assistant_workspaces',
      'instance_id,sandbox_name,active_sandbox_name,lease_expires_at', 'instance_id');
    for (const row of assistantWorkspaces) {
      // Exclude live operations from the advisory inventory.
      if (Date.parse(row.lease_expires_at || '') > Date.now()) {
        activeSandboxIds.add(row.active_sandbox_name || row.sandbox_name);
      }
    }
    const assistantDeletions = new Set((await housekeepingRows('assistant_workspace_deletions', 'sandbox_name', 'sandbox_name'))
      .map(row => row.sandbox_name));

    console.log(`[SandboxHousekeeping] Fetched ${activeSandboxIds.size} active sandbox IDs and ${activeSnapshotIds.size} active snapshot IDs from DB.`);
    
    const thirtyMinutesAgo = Date.now() - 30 * 60 * 1000;

    stage = 'sandbox_inventory';
    const listed = await listHousekeepingSandboxes(credentials);
    const deleted = new Set<string>();
    // Reconcile ALL registered resources, including stopped sessions after auto
    // timeout and resources omitted from a provider list page. No implicit resume.
    stage = 'billing_inventory';
    const tracked = await housekeepingRows('sandbox_billing_resources','sandbox_name,deletion_requested_at','sandbox_name',undefined,true);
    for (const row of tracked || []) {
      let sandbox: Sandbox | undefined;
      try {
        sandbox = await Sandbox.get({ ...credentials, name: row.sandbox_name, resume: false });
        await reconcileSandboxBilling(sandbox);
        const terminal = harnessRows.find(session => row.sandbox_name === `h-${session.id}` &&
          ['completed','cancelled','failed'].includes(session.snapshot?.status) && session.site_id &&
          session.snapshot?.request?.requirementId);
        if (terminal && !activeSandboxIds.has(row.sandbox_name)) {
          const fence = await claimSandboxCleanup({ sessionId: terminal.id, siteId: terminal.site_id,
            owner: null, resource: row.sandbox_name });
          if (fence) {
            await fence.assert();
            if (!await stopSandboxQuiet(sandbox)) throw new Error('Terminal sandbox stop pending');
            await reconcileSandboxBilling(sandbox);
            await retireSandboxBilling(row.sandbox_name,'begin');
            await fence.assert();
            await sandbox.delete({ deleteOrphanSnapshots: true });
            await retireSandboxBilling(row.sandbox_name,'finish');
            await fence.finish();
            deleted.add(row.sandbox_name);
            results.terminalSandboxesDeleted++;
          }
        }
        if (!deleted.has(row.sandbox_name) && (row.deletion_requested_at || assistantDeletions.has(row.sandbox_name))) {
          // A request to retire is not exclusive ownership of a provider handle.
          results.deferredDeletionIntents++;
        }
        results.sandboxesBilled++;
      } catch (error) {
        if (!sandbox && isSandboxNotFoundError(error)) {
          if (row.deletion_requested_at) {
            try { await retireSandboxBilling(row.sandbox_name,'finish'); continue; } catch { /* Pending intent remains actionable. */ }
          }
        }
        results.billingErrors++;
        const reason = !sandbox && isSandboxNotFoundError(error) ? 'missing_resource'
          : error instanceof SandboxBillingError && error.code === 'insufficient_credits'
            ? 'insufficient_credits' : 'reconciliation_pending';
        if (reason === 'missing_resource') results.missingResources++;
        else if (reason === 'insufficient_credits') results.fundingPending++;
        else results.reconciliationPending++;
        // A billing or claim failure is not a stop fence.
      }
    }

    // No common lease across requirement, workflow and assistant reuse. Inventory
    // can identify candidates for review, never authorize stop or snapshot deletion.
    for (const sb of listed) {
      if (deleted.has(sb.id) || activeSandboxIds.has(sb.id) || (sb.name && activeSandboxIds.has(sb.name))) continue;
      const createdAt = sb.createdAt ? new Date(sb.createdAt).getTime() : 0;
      if (!createdAt || createdAt < thirtyMinutesAgo) results.unfencedSandboxCandidates++;
    }

    console.log('[SandboxHousekeeping] Cleanup complete.', results);
    return NextResponse.json({ success: true, results });
  } catch (error) {
    const status = error && typeof error === 'object' && 'response' in error
      ? (error.response as { status?: unknown } | null)?.status : undefined;
    console.error('[SandboxHousekeeping] Reconciliation failed; cleanup will retry.', {
      stage, ...(typeof status === 'number' ? { httpStatus: status } : {}),
    });
    return new NextResponse('Sandbox housekeeping unavailable', { status: 500 });
  }
}

export const GET = withCronObservation('sandbox-housekeeping', runCron);
