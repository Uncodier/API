'use step';

import { executeAssistantStep } from '@/lib/services/robot-instance/assistant-executor';
import { loadUserActionHistory } from '@/lib/services/instance-user-history';
import {
  buildCycleWrapUpSystemPrompt,
  shouldRunCycleWrapUp,
} from '@/lib/services/cycle-wrapup-prompt';
import { loadLatestDocsDigestFromLogs } from '@/lib/services/docs-cycle-digest';
// Import from lib/tools via assistantProtocol that only pulls requirement-status-core
// (no next/server). Do NOT import system_notification here — its route pulls next/server
// and breaks the Vercel Workflow bundler.
import { requirementStatusTool } from '@/app/api/agents/tools/requirement_status/assistantProtocol';
import type { DocsDigestResult } from './docs-digest-step';
import type { CronAuditContext } from '@/lib/services/cron-audit-log';

export interface CycleWrapUpParams {
  sandboxId?: string;
  siteId: string;
  instanceId: string;
  userId?: string;
  requirementId: string;
  title: string;
  instructions: string | null;
  /** Slim digest marker from emitDocsDigestStep — full bodies are reloaded from logs. */
  digest: DocsDigestResult | null;
  planCompleted: boolean;
  previewUrl?: string | null;
  repoUrl?: string | null;
  audit?: CronAuditContext;
}

export async function emitCycleWrapUpStep(params: CycleWrapUpParams): Promise<{ ran: boolean }> {
  'use step';
  const {
    siteId,
    instanceId,
    userId,
    requirementId,
    title,
    instructions,
    digest,
    planCompleted,
    previewUrl,
    repoUrl,
  } = params;

  try {
    const history = await loadUserActionHistory(instanceId, { requirementId });

    // Reload full digest from the log written by emitDocsDigestStep (slim workflow payload).
    let digestFiles =
      digest?.emitted
        ? await loadLatestDocsDigestFromLogs(instanceId, requirementId)
        : null;
    if (!digestFiles && digest?.emitted) {
      // Fallback: try without requirement filter
      digestFiles = await loadLatestDocsDigestFromLogs(instanceId);
    }

    if (
      !shouldRunCycleWrapUp({
        hasDigest: !!(digestFiles && digestFiles.length > 0),
        userMessageCount: history.totalCount,
      })
    ) {
      console.log(
        `[CycleWrapUpStep] Skipping wrap-up for ${requirementId} — no docs digest and no user messages`,
      );
      return { ran: false };
    }

    const systemPrompt = buildCycleWrapUpSystemPrompt({
      title,
      requirementId,
      instructions,
      historyPromptText: history.promptText,
      historyMode: history.mode,
      digestFiles,
      planCompleted,
      previewUrl,
      repoUrl,
    });

    const tools = [requirementStatusTool(siteId, instanceId)];

    let currentMessages: any[] = [
      {
        role: 'user',
        content:
          'Please review the digest and history, update status if needed, and write the final wrap-up message for the client.',
      },
    ];

    console.log(
      `[CycleWrapUpStep] Running wrap-up for req ${requirementId} with history mode=${history.mode} digestFiles=${digestFiles?.length ?? 0}`,
    );

    const wrapupModel = process.env.AI_CODE_MODEL || 'gemini-3.1-pro-preview-customtools';
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
          ai_model: wrapupModel,
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

    console.log(`[CycleWrapUpStep] Completed in ${turns} turns for req ${requirementId}`);
    return { ran: true };
  } catch (error: unknown) {
    console.warn(
      `[CycleWrapUpStep] Failed to run wrap-up for req ${requirementId}:`,
      error instanceof Error ? error.message : error,
    );
    return { ran: false };
  }
}
