import { NextRequest, NextResponse } from 'next/server';
import { CreditService } from '@/lib/services/billing/CreditService';
import { z } from 'zod';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { start } from 'workflow/api';
import { runAssistantWorkflow } from './workflow';
import { resetRequirementOnUserAction } from '@/lib/services/requirement-cron-reset';
import { insertUserActionLog, markRemoteInstanceError, withRetries } from './user-message-log';
import { assistantResponseStream } from './response-stream';
import { normalizePublishToolOverrides } from './publish-tool-overrides';
import { approvedCommunityImport, assistantSkillSelectionSchema, resolveAssistantSkillSelection } from './skill-selection';
import { canAccessSite } from '@/lib/security/site-access';
import { isSiteSkillManager } from '@/lib/services/site-skill-access';

// ------------------------------------------------------------------------------------
// POST /api/robots/instance/assistant
// Assistant route that triggers a Vercel Workflow for execution
// ------------------------------------------------------------------------------------

export const maxDuration = 800; // 13 min (Pro + Fluid Compute); falls back to 300s without it

const AssistantSchema = z.object({
  instance_id: z.string().uuid('instance_id must be valid UUID').optional(),
  instance_node_id: z.string().uuid().optional(),
  expected_results_amount: z.number().int().min(1).max(20).optional().default(1),
  message: z.string().min(1, 'message is required'),
  site_id: z.string().min(1, 'site_id is required when creating new instance').optional(),
  user_id: z.string().uuid().optional(),
  tools: z.array(z.any()).optional().default([]),
  use_sdk_tools: z.boolean().optional().default(false),
  system_prompt: z.string().optional(),
  context: z.string().optional(),
  tool_overrides: z.record(z.any()).optional(),
  request_id: z.string().min(1).max(200).optional(),
  ...assistantSkillSelectionSchema.shape,
});

export async function POST(request: NextRequest) {
  let failureContext: { instanceId: string; siteId: string; userId?: string | null; userMessageLogId?: string } | undefined;
  try {
    const rawBody = await request.json();
    // Do not log request payload: it can contain private context and prompts.
    
    let parsedBody;
    try {
      parsedBody = AssistantSchema.parse(rawBody);
    } catch (zodError: any) {
      console.error('Validation Error:', zodError.errors || zodError.message);
      return NextResponse.json({ success: false, error: 'Invalid request data', details: zodError.errors }, { status: 400 });
    }

    // Validate credits PRE-FLIGHT before starting any workflow
    const site_id_for_validation = parsedBody.site_id || (parsedBody.instance_id ? (await supabaseAdmin.from('remote_instances').select('site_id').eq('id', parsedBody.instance_id).single()).data?.site_id : null);
    
    if (site_id_for_validation) {
      const hasCredits = await CreditService.validateCredits(site_id_for_validation, 0.001);
      if (!hasCredits) {
        return NextResponse.json(
          { success: false, error: 'Insufficient credits for assistant execution', code: 'INSUFFICIENT_CREDITS' },
          { status: 402 }
        );
      }
    }

    const {
      instance_id: providedInstanceId,
      instance_node_id: providedNodeId,
      expected_results_amount: expectedResults,
      message,
      site_id: providedSiteId,
      user_id: providedUserId,
      tools: customTools,
      use_sdk_tools,
      system_prompt,
    } = parsedBody;
    const normalizedToolOverrides = normalizePublishToolOverrides(
      parsedBody.context,
      parsedBody.tool_overrides,
    );

    if (providedInstanceId && providedSiteId) {
      const { data: scope } = await supabaseAdmin.from('remote_instances')
        .select('site_id').eq('id', providedInstanceId).maybeSingle();
      if (scope && scope.site_id !== providedSiteId) {
        return NextResponse.json({ error: 'Instance does not belong to site' }, { status: 403 });
      }
    }
    const selectionSiteId = providedSiteId || site_id_for_validation;
    if (!selectionSiteId) return NextResponse.json({ error: 'site_id is required' }, { status: 400 });
    const verifiedUserId = request.headers.get('x-auth-validated') === 'true'
      ? request.headers.get('x-auth-user-id') : null;
    const requestedImport = approvedCommunityImport(message);
    const trustedImportUserId = verifiedUserId && z.string().uuid().safeParse(verifiedUserId).success
      ? verifiedUserId : null;
    // Internal service calls retain existing behavior but never authorize a write via a user_id in the body.
    let approvedImport: { url: string; sha256: string; userId: string } | undefined;
    if (requestedImport && trustedImportUserId) {
      const hasSiteAccess = await canAccessSite(request, selectionSiteId);
      const isManager = hasSiteAccess && await isSiteSkillManager(selectionSiteId, trustedImportUserId);
      if (!isManager) return NextResponse.json({ error: 'Site manager access required to import skills' }, { status: 403 });
      approvedImport = { ...requestedImport, userId: trustedImportUserId };
    }
    let selectedSkills;
    try {
      selectedSkills = await resolveAssistantSkillSelection(selectionSiteId, parsedBody);
    } catch (error) {
      return NextResponse.json({ error: error instanceof Error ? error.message : 'Invalid skill selection' }, { status: 400 });
    }

    // CASE 1: No instance_id provided - Create new uninstantiated instance (FAST PATH - No Workflow needed for creation)
    if (!providedInstanceId) {
      console.log(`₍ᐢ•(ܫ)•ᐢ₎ Creating new uninstantiated instance`);

      if (!providedSiteId) {
        return NextResponse.json(
          { error: 'site_id is required when creating new instance' },
          { status: 400 }
        );
      }

      // Get site info to get user_id
      const { data: site, error: siteError } = await supabaseAdmin
        .from('sites')
        .select('user_id')
        .eq('id', providedSiteId)
        .single();

      if (siteError || !site) {
        return NextResponse.json({ error: 'Site not found' }, { status: 404 });
      }

      const userId = providedUserId || site.user_id;

      // Create uninstantiated instance
      const { data: newInstance, error: instanceError } = await supabaseAdmin
        .from('remote_instances')
        .insert({
          name: 'Assistant Session',
          instance_type: 'ubuntu',
          status: 'uninstantiated',
          site_id: providedSiteId,
          user_id: userId,
          created_by: userId,
          timeout_hours: 1,
        })
        .select()
        .single();

      if (instanceError || !newInstance) {
        return NextResponse.json(
          { error: 'Failed to create instance', details: instanceError },
          { status: 500 }
        );
      }

      console.log(`₍ᐢ•(ܫ)•ᐢ₎ Created uninstantiated instance: ${newInstance.id}`);

      failureContext = { instanceId: newInstance.id, siteId: providedSiteId, userId };
      const userAction = await withRetries(() => insertUserActionLog({
        instanceId: newInstance.id,
        siteId: providedSiteId,
        userId,
        message,
        details: { is_creation: true, request_id: parsedBody.request_id, status: 'running' },
      }));
      failureContext.userMessageLogId = userAction.id;

      const workflowRun = await start(runAssistantWorkflow, [
        newInstance.id,
        message,
        providedSiteId,
        userId,
        customTools,
        use_sdk_tools,
        system_prompt,
        undefined,
        undefined,
        providedNodeId,
        expectedResults,
        parsedBody.context,
        normalizedToolOverrides,
        { selectedSkills, approvedImport, userMessageLogId: userAction.id }
      ]);

      return assistantResponseStream(workflowRun, newInstance.id, userAction.id, { signal: request.signal });
    }

    // CASE 2: Existing instance_id provided - Execute via Workflow
    console.log(`₍ᐢ•(ܫ)•ᐢ₎ Executing on existing instance: ${providedInstanceId}`);

    // Get instance to verify existence and ownership
    const { data: instance, error: instanceError } = await supabaseAdmin
      .from('remote_instances')
      .select('site_id, user_id, status')
      .eq('id', providedInstanceId)
      .single();

    if (instanceError || !instance) {
      return NextResponse.json({ error: 'Instance not found' }, { status: 404 });
    }

    const site_id = providedSiteId || instance.site_id;
    const user_id = providedUserId || instance.user_id;
    failureContext = { instanceId: providedInstanceId, siteId: site_id, userId: user_id };

    const userAction = await withRetries(() => insertUserActionLog({
      instanceId: providedInstanceId,
      siteId: site_id,
      userId: user_id,
      message,
      skipDuplicateCheck: true,
      details: { instance_status: instance.status || 'running', request_id: parsedBody.request_id, status: 'running' },
    }));
    failureContext.userMessageLogId = userAction.id;
    
    // Finish recovery before the workflow reads requirement/backlog state.
    await resetRequirementOnUserAction(
      providedInstanceId,
      userAction.id,
    );

    // Start the workflow
    const workflowRun = await start(runAssistantWorkflow, [
      providedInstanceId,
      message,
      site_id,
      user_id,
      customTools,
      use_sdk_tools,
      system_prompt,
      undefined,
      undefined,
      providedNodeId,
      expectedResults,
      parsedBody.context,
      normalizedToolOverrides,
      { selectedSkills, approvedImport, userMessageLogId: userAction.id }
    ]);

    return assistantResponseStream(workflowRun, providedInstanceId, userAction.id, { signal: request.signal });

  } catch (err: any) {
    console.error('Error in POST /robots/instance/assistant:', err);
    // A startup failure happens before the workflow's own catch can log it.
    // Only write after loading the instance/site scope. Logging failure must
    // never replace the HTTP error or keep the client waiting indefinitely.
    if (failureContext) {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          markRemoteInstanceError({ ...failureContext, errorMessage: 'Assistant request could not be started. Please retry.' })
            .catch(() => {}),
          new Promise<void>(resolve => { timeout = setTimeout(resolve, 2000); }),
        ]);
      } finally { clearTimeout(timeout); }
    }
    
    // Check if it's an insufficient credits error
    if (err?.name === 'InsufficientCreditsError' || err?.message?.includes('Insufficient credits')) {
      return NextResponse.json(
        { success: false, error: err.message, code: 'INSUFFICIENT_CREDITS' },
        { status: 402 } // 402 Payment Required
      );
    }
    
    return NextResponse.json({
      success: false,
      error: { code: 'ASSISTANT_START_FAILED', message: 'Failed to start assistant execution. Please try again.' },
    }, { status: 500 });
  }
}
