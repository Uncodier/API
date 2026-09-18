import { CronExpressionParser } from 'cron-parser';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import {
  gatingItems,
  hasOutstandingWork,
  isBacklogComplete,
  outstandingGatingItems,
} from '@/lib/services/requirement-backlog';
import { mutateBacklogAtomically } from '@/lib/services/requirement-backlog-mutation';
import { computeRatio } from '@/lib/services/requirement-backlog-store';
import { patchRequirementMetadataKeys } from '@/lib/services/requirement-metadata-patch';
import { resumeRequirementExecutionOnUserAction } from '@/lib/services/requirement-execution-recovery';

type RequirementRow = {
  id: string;
  status: string;
  site_id: string;
  user_id?: string;
  title?: string;
  instructions?: string | null;
  type?: string;
  cron?: string | null;
  updated_at?: string | null;
  backlog_revision?: number | null;
  backlog?: { items?: any[] } | null;
  metadata?: Record<string, any> | null;
};

export type RequirementRunPreparation = {
  status: string;
  backlog: RequirementRow['backlog'];
  metadata: RequirementRow['metadata'];
  skipReason?: string;
};

const CRON_CANDIDATE_PAGE_SIZE = 100;

export type CronRequirementCandidate = RequirementRow & {
  user_id: string;
  title: string;
  instructions: string | null;
  type: string;
};

export async function listRequirementsForCronRun(): Promise<CronRequirementCandidate[]> {
  const requirements = new Map<string, CronRequirementCandidate>();
  let offset = 0;

  while (true) {
    const { data, error } = await supabaseAdmin
      .from('requirements')
      .select('*')
      .or(
        'status.in.(backlog,in-progress,blocked),and(status.in.(on-review,done,cancelled),cron.not.is.null)',
      )
      .order('updated_at', { ascending: true, nullsFirst: true })
      .order('id', { ascending: true })
      .range(offset, offset + CRON_CANDIDATE_PAGE_SIZE - 1);
    if (error) throw error;

    const page = (data || []) as CronRequirementCandidate[];
    for (const requirement of page) {
      requirements.set(requirement.id, requirement);
    }
    if (page.length < CRON_CANDIDATE_PAGE_SIZE) break;
    offset += CRON_CANDIDATE_PAGE_SIZE;
  }

  return Array.from(requirements.values());
}

export async function cleanupRecentlyCompletedRequirements(): Promise<void> {
  const { data: recentCompletedReqs } = await supabaseAdmin
    .from('requirements')
    .select('id, status, backlog, metadata, site_id, updated_at, backlog_revision')
    .in('status', ['done', 'on-review', 'cancelled'])
    .order('updated_at', { ascending: false })
    .limit(100);

  for (const requirement of recentCompletedReqs || []) {
    const isComplete = isBacklogComplete(requirement.backlog?.items || []);
    if (
      ['on-review', 'done'].includes(requirement.status) &&
      hasOutstandingWork(requirement.backlog?.items || [])
    ) {
      await resumeRequirementExecutionOnUserAction(
        requirement.id,
        typeof requirement.metadata?.runner_instance_id === 'string'
          ? requirement.metadata.runner_instance_id
          : null,
        false,
        `outstanding-backlog:${requirement.backlog_revision ?? requirement.updated_at ?? 'unknown'}`,
        true,
      );
      requirement.status = 'in-progress';
    }

    if (
      ['on-review', 'done', 'cancelled'].includes(requirement.status) &&
      (isComplete || requirement.status === 'cancelled')
    ) {
      await supabaseAdmin
        .from('remote_instances')
        .update({ status: 'pending' })
        .eq('site_id', requirement.site_id)
        .like('name', `%req-%${requirement.id.substring(0, 8)}%`)
        .in('status', ['running', 'starting', 'paused']);
      if (requirement.status === 'done' || requirement.status === 'cancelled') {
        const { deleteRequirementSandboxes } = await import(
          '@/lib/services/sandbox-lifecycle'
        );
        await deleteRequirementSandboxes(
          requirement.id,
          requirement.metadata?.runner_instance_id,
        );
      }
    }
  }
}

export async function prepareRequirementForCronRun(params: {
  requirement: RequirementRow;
  currentStatus: string;
  instanceId?: string;
}): Promise<RequirementRunPreparation> {
  const { requirement, instanceId } = params;
  const requirementId = requirement.id;
  let status = params.currentStatus;
  let backlog = requirement.backlog;
  let metadata = requirement.metadata;
  const wasComplete = isBacklogComplete(backlog?.items || []);
  let reactivatedByCron = false;

  if (
    requirement.cron &&
    ['on-review', 'done', 'cancelled', 'blocked'].includes(status)
  ) {
    try {
      const interval = CronExpressionParser.parse(requirement.cron);
      const previousRun = interval.prev().toDate();
      const lastTerminalTime = requirement.updated_at
        ? new Date(requirement.updated_at).getTime()
        : 0;
      const now = Date.now();
      if (
        previousRun.getTime() > lastTerminalTime &&
        now - previousRun.getTime() < 120_000
      ) {
        console.log(
          `[Cron Apps] Requirement ${requirementId} cron triggered. Reactivating from ${status} to in-progress.`,
        );
        const itemId = crypto.randomUUID();
        backlog = await mutateBacklogAtomically(
          requirementId,
          ({ backlog: latestBacklog }) => {
            latestBacklog.items = latestBacklog.items.map((item: any) => {
              const stale =
                item.status === 'in_progress' &&
                now - new Date(item.updated_at || 0).getTime() >
                  24 * 60 * 60 * 1000;
              return item.status === 'failed' ||
                item.status === 'blocked' ||
                stale
                ? {
                    ...item,
                    status: 'pending',
                    updated_at: new Date().toISOString(),
                  }
                : item;
            });
            latestBacklog.items.push({
              id: itemId,
              title: 'Cron Iteration: Analyze state, implement improvements and continue',
              kind: 'subtask',
              phase_id: latestBacklog.current_phase_id || 'default',
              status: 'pending',
              acceptance: [
                'Analyze the current application and record concrete missing or regressed behavior.',
                'Implement the requested behavior and verify its observable result.',
                'Push the verified changes to the repository.',
              ],
              attempts: 0,
              scope_level: 'full',
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            });
            latestBacklog.completion_ratio = computeRatio(latestBacklog.items);
            return { result: latestBacklog };
          },
        );
        const recoveryInstanceId =
          instanceId ||
          (
            typeof metadata?.runner_instance_id === 'string'
              ? metadata.runner_instance_id
              : null
          );
        await resumeRequirementExecutionOnUserAction(
          requirementId,
          recoveryInstanceId,
          false,
          `scheduled-cron:${previousRun.toISOString()}`,
          true,
        );
        metadata = await patchRequirementMetadataKeys({
          requirementId,
          patch: {
            all_done_cycles: 0,
            has_completed_backlog: false,
          },
          removeKeys: ['cron_blocker_provenance', 'cron_blocker_version'],
        });
        status = 'in-progress';
        reactivatedByCron = true;
      }
    } catch (error) {
      console.error(
        `[Cron Apps] Invalid cron schedule for req ${requirementId}: ${requirement.cron}`,
        error,
      );
    }
  }

  let keepTerminal = wasComplete && !reactivatedByCron;
  if (keepTerminal && hasOutstandingWork(backlog?.items || [])) {
    const hasCoreOutstanding =
      outstandingGatingItems(backlog?.items || []).length > 0;
    let hasRecentOrnamental = false;
    if (!hasCoreOutstanding) {
      const { data: lastStatus } = await supabaseAdmin
        .from('requirement_status')
        .select('created_at')
        .eq('requirement_id', requirementId)
        .in('stage', ['on-review', 'done'])
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      const lastTerminalTime = lastStatus
        ? new Date(lastStatus.created_at).getTime()
        : Date.now();
      const newestItemUpdate = Math.max(
        ...(backlog?.items || []).map((item: any) =>
          new Date(item.updated_at || item.created_at || 0).getTime(),
        ),
      );
      hasRecentOrnamental = lastStatus
        ? newestItemUpdate > lastTerminalTime
        : hasOutstandingWork(backlog?.items || []);
    }
    if (hasCoreOutstanding || hasRecentOrnamental) keepTerminal = false;
  }

  if (keepTerminal) {
    const gating = gatingItems(backlog?.items || []);
    const lastCoreUpdate = Math.max(
      ...gating.map((item: any) => new Date(item.updated_at || 0).getTime()),
    );
    const minutesSinceCoreDone = (Date.now() - lastCoreUpdate) / 60_000;
    const cooldownMinutes = parseInt(
      process.env.CRON_BACKLOG_DONE_COOLDOWN_MIN || '15',
      10,
    );
    if (minutesSinceCoreDone < cooldownMinutes) {
      console.log(
        `[Cron Apps] Skip ${requirementId} — gating backlog done ${minutesSinceCoreDone.toFixed(1)} min ago (cooldown ${cooldownMinutes} min)`,
      );
      return {
        status,
        backlog,
        metadata,
        skipReason: 'backlog_cooldown',
      };
    }
    if (!['on-review', 'done', 'cancelled'].includes(status)) {
      await supabaseAdmin
        .from('requirements')
        .update({ status: 'on-review', updated_at: new Date().toISOString() })
        .eq('id', requirementId);
      status = 'on-review';
      await supabaseAdmin.from('requirement_status').insert({
        requirement_id: requirementId,
        site_id: requirement.site_id,
        instance_id: instanceId || null,
        stage: 'on-review',
        message: 'Project complete (auto-promoted after cooldown)',
      });
    }
  } else if (
    ['on-review', 'done'].includes(status) &&
    hasOutstandingWork(backlog?.items || [])
  ) {
    console.log(
      `[Cron Apps] Requirement ${requirementId} is ${status} but has outstanding work. Reverting to in-progress.`,
    );
    await resumeRequirementExecutionOnUserAction(
      requirementId,
      instanceId ||
        (
          typeof metadata?.runner_instance_id === 'string'
            ? metadata.runner_instance_id
            : null
        ),
      false,
      `outstanding-backlog:${requirement.backlog_revision ?? requirement.updated_at ?? 'unknown'}`,
      true,
    );
    metadata = await patchRequirementMetadataKeys({
      requirementId,
      patch: {},
    });
    status = 'in-progress';
  }

  if (status === 'blocked') {
    return { status, backlog, metadata, skipReason: 'blocked' };
  }

  if (
    ['cancelled', 'done'].includes(status) ||
    (
      status === 'on-review' &&
      wasComplete &&
      !hasOutstandingWork(backlog?.items || [])
    )
  ) {
    await supabaseAdmin
      .from('remote_instances')
      .update({ status: 'pending' })
      .eq('site_id', requirement.site_id)
      .like('name', `%req-%${requirementId.substring(0, 8)}%`)
      .in('status', ['running', 'starting', 'paused']);
    const { data: instances } = await supabaseAdmin
      .from('remote_instances')
      .select('id')
      .eq('site_id', requirement.site_id)
      .like('name', `%req-%${requirementId.substring(0, 8)}%`);
    if (instances?.length) {
      await supabaseAdmin
        .from('instance_plans')
        .update({ status: 'cancelled' })
        .in('instance_id', instances.map((instance) => instance.id))
        .in('status', ['pending', 'in_progress', 'active']);
    }
    return { status, backlog, metadata, skipReason: status };
  }

  return { status, backlog, metadata };
}

export async function runRequirementRecoveryPrepass(): Promise<void> {
  try {
    const { runOnReviewSanitization } = await import(
      '@/lib/services/requirement-onreview-sanitizer'
    );
    const result = await runOnReviewSanitization();
    if (result.requirementsSanitized > 0) {
      console.log(
        `[Cron Apps] Auto-sanitization recovered ${result.requirementsSanitized} requirements (reopened ${result.itemsReopened} items).`,
      );
    }
  } catch (error) {
    console.error('[Cron Apps] Error during auto-sanitization pass:', error);
  }

  try {
    const { reconcilePendingDeploymentInfrastructureWaits } = await import(
      '@/lib/services/deployment-infrastructure-fallback'
    );
    const result = await reconcilePendingDeploymentInfrastructureWaits(20);
    if (result.recovered > 0) {
      console.log(
        `[Cron Apps] Recovered ${result.recovered} deployment infrastructure wait(s).`,
      );
    }
  } catch (error) {
    console.warn(
      '[Cron Apps] Deployment infrastructure fallback unavailable:',
      error instanceof Error ? error.message : error,
    );
  }
}
