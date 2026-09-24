'use step';

import { executeAssistantStep } from '@/lib/services/robot-instance/assistant-executor';
import { loadLatestDocsDigestFromLogs, formatDigestForPrompt } from '@/lib/services/docs-cycle-digest';
import { requirementBacklogTool } from '@/app/api/agents/tools/requirement_backlog/assistantProtocol';
import type { DocsDigestResult } from './docs-digest-step';
import type { CronAuditContext } from '@/lib/services/cron-audit-log';
import { patchRequirementMetadataKeys } from '@/lib/services/requirement-metadata-patch';

export interface SyncDocsToBacklogParams {
  sandboxId?: string;
  siteId: string;
  instanceId: string;
  userId?: string;
  requirementId: string;
  digest: DocsDigestResult | null;
  audit?: CronAuditContext;
}

export async function emitSyncDocsToBacklogStep(params: SyncDocsToBacklogParams): Promise<{ ran: boolean }> {
  'use step';
  const {
    siteId,
    instanceId,
    userId,
    requirementId,
    digest,
  } = params;

  try {
    const { supabaseAdmin } = await import('@/lib/database/supabase-client');

    const { data: req } = await supabaseAdmin
      .from('requirements')
      .select('metadata, backlog, type, title')
      .eq('id', requirementId)
      .single();

    if (!req) {
      console.warn(`[SyncDocsToBacklogStep] Requirement ${requirementId} not found`);
      return { ran: false };
    }

    const metadata = (req.metadata || {}) as Record<string, any>;
    const lastSyncAt = metadata.last_docs_to_backlog_sync_at;

    // Rate limiting: check if 24 hours have passed
    if (lastSyncAt) {
      const lastSync = new Date(lastSyncAt).getTime();
      const now = Date.now();
      const hoursSinceLastSync = (now - lastSync) / (1000 * 60 * 60);
      
      if (hoursSinceLastSync < 24) {
        console.log(`[SyncDocsToBacklogStep] Skipping sync for ${requirementId} - last synced ${hoursSinceLastSync.toFixed(1)} hours ago`);
        return { ran: false };
      }
    }

    // Load full digest from the log written by emitDocsDigestStep (slim workflow payload).
    let digestFiles = digest?.emitted
      ? await loadLatestDocsDigestFromLogs(instanceId, requirementId)
      : null;
      
    if (!digestFiles && digest?.emitted) {
      digestFiles = await loadLatestDocsDigestFromLogs(instanceId);
    }

    if (!digestFiles || digestFiles.length === 0) {
      console.log(`[SyncDocsToBacklogStep] Skipping sync for ${requirementId} - no docs digest`);
      return { ran: false };
    }

    // Format backlog for context
    const backlogData = (req.backlog || {}) as Record<string, any>;
    const backlogItems = backlogData.items || [];
    const backlogContext = backlogItems.length > 0 
      ? backlogItems.map((i: any) => `- [${i.id}] ${i.status}: ${i.title}`).join('\n')
      : '(empty backlog)';

    const digestText = formatDigestForPrompt(digestFiles);

    const systemPrompt = `You are a backlog management agent. Your task is to analyze recent documentation updates and determine if any NEW, actionable work items have been discovered that are NOT yet tracked in the project backlog.

ROLE & TASK:
You must evaluate the facts found in the Docs Digest against the Current Backlog. If you find concrete, un-tracked work (e.g. newly designed features, missing pages, newly documented API endpoints to build), you must use the \`requirement_backlog\` tool with \`action="upsert"\` to add them.

HARD RULES:
1. NO DUPLICATES: Do NOT add items that overlap with existing backlog items (even if they are done, in-progress, or pending).
2. CONCRETE WORK ONLY: Only add items that represent concrete execution work (e.g. building a component, creating an API, adding a page). Do not add vague or purely narrative tasks.
3. UPSERT ONLY: Only use the \`requirement_backlog\` tool with \`action="upsert"\`. Do not try to start, complete, or list items.
4. HIGHLY SELECTIVE: It is perfectly fine to do nothing if the docs don't reveal any new missing actionable work. Just finish your turn.
5. ACCEPTANCE CONTRACT: Every new core item MUST include both concrete acceptance[] text and acceptance_contract with schema_version=2, source="declared", and one typed executable all_of claim per criterion. Route behavior must use page_response or http_response claims. Semantic-only claims also require discovery.query and discovery.hypothetical_code.

=== REQUIREMENT INFO ===
Title: ${req.title}
ID: ${requirementId}

=== CURRENT BACKLOG ===
${backlogContext}

${digestText}
`;

    const tools = [requirementBacklogTool(siteId, requirementId)];

    let currentMessages: any[] = [
      {
        role: 'user',
        content: 'Please review the docs digest and current backlog, and upsert any NEW concrete work items discovered if they are missing from the backlog. If no new items are found, just finish your turn.',
      },
    ];

    console.log(`[SyncDocsToBacklogStep] Running docs-to-backlog sync for req ${requirementId} with digestFiles=${digestFiles.length}`);

    const syncModel = process.env.AI_CODE_MODEL || 'gemini-3.1-pro-preview-customtools';
    let turns = 0;
    let isDone = false;

    while (!isDone && turns < 3) {
      const result = await executeAssistantStep(
        currentMessages,
        { id: instanceId, site_id: siteId, user_id: userId, requirement_id: requirementId },
        {
          use_sdk_tools: false,
          provider: 'gemini',
          ai_provider: 'gemini',
          ai_model: syncModel,
          instance_id: instanceId,
          site_id: siteId,
          user_id: userId,
          requirement_id: requirementId,
          system_prompt: systemPrompt,
          custom_tools: tools,
        },
      );

      currentMessages = result.messages;
      isDone = result.isDone;
      turns++;
    }

    console.log(`[SyncDocsToBacklogStep] Completed in ${turns} turns for req ${requirementId}`);

    // Update last_docs_to_backlog_sync_at
    await patchRequirementMetadataKeys({
      requirementId,
      patch: {
        last_docs_to_backlog_sync_at: new Date().toISOString(),
      },
    });

    return { ran: true };
  } catch (error: unknown) {
    console.warn(
      `[SyncDocsToBacklogStep] Failed to run sync for req ${requirementId}:`,
      error instanceof Error ? error.message : error,
    );
    return { ran: false };
  }
}
