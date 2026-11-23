import { NextRequest, NextResponse } from 'next/server';
import { admitAssistantRouting, validateAssistantInferenceAdmission } from './execution-routing';
import { z } from 'zod';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { start } from 'workflow/api';
import { runAssistantWorkflow } from './workflow';
import { AskSubmissionError, claimAskSubmission, firstAskInstanceId } from './ask-submission';
import { assistantResponseStream } from './response-stream';
import { normalizePublishToolOverrides } from './publish-tool-overrides';
import { approvedCommunityImport, assistantSkillSelectionSchema, resolveAssistantSkillSelection } from './skill-selection';
import { canAccessSite } from '@/lib/security/site-access';
import { isSiteSkillManager } from '@/lib/services/site-skill-access';
import { isNodeSpecificContext, NODE_CONTEXT_REQUIRES_NODE, NODE_CONTEXT_REQUIRES_NODE_MESSAGE } from './node-context-boundary';
import { canToolPrincipalAccessSite, resolveToolRequestPrincipal } from '@/lib/security/tool-request-principal';
import { assistantInstanceAccess } from '@/lib/security/assistant-instance-access';
import { resolveAssistantRequestMode } from './execution-mode';

// ------------------------------------------------------------------------------------
// POST /api/robots/instance/assistant
// Assistant route that triggers a Vercel Workflow for execution
// ------------------------------------------------------------------------------------

export const maxDuration = 800; // 13 min (Pro + Fluid Compute); falls back to 300s without it

const AssistantSchema = z.object({
  instance_id: z.string().uuid('instance_id must be valid UUID').transform(value => value.toLowerCase()).optional(),
  connector_id_hint: z.string().uuid().transform(value => value.toLowerCase()).optional(),
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
  request_id: z.string().min(1).max(200).refine(value => value.trim().length > 0, 'request_id cannot be blank').optional(),
  execution_mode: z.enum(['direct', 'harness']).optional(),
  ...assistantSkillSelectionSchema.shape,
});

export async function POST(request: NextRequest) {
  let claimedTurn: { instance_id: string; user_log_id: string } | undefined;
  try {
    const principal = await resolveToolRequestPrincipal(request);
    if (!principal) return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
    const rawBody = await request.json();
    // Do not log request payload: it can contain private context and prompts.
    
    let parsedBody;
    try {
      parsedBody = AssistantSchema.parse(rawBody);
    } catch (zodError: any) {
      console.error('Validation Error:', zodError.errors || zodError.message);
      return NextResponse.json({ success: false, error: 'Invalid request data', details: zodError.errors }, { status: 400 });
    }

    // Node-shaped requests must not fall through to conversation execution or
    // normalize node overrides before a scoped node can be resolved durably.
    if (/\/assistant\/connector\/?$/.test(request.nextUrl.pathname) && !parsedBody.connector_id_hint) {
      return NextResponse.json({ error: 'Selected connector account required.' }, { status: 400 });
    }
    if (parsedBody.connector_id_hint && (principal.internal || !principal.userId || !parsedBody.instance_id || parsedBody.instance_node_id)) {
      return NextResponse.json({ error: 'Connector selection requires an interactive instance conversation.' }, { status: 400 });
    }
    const hasNodeContext = isNodeSpecificContext(parsedBody.context);
    if (hasNodeContext && !parsedBody.instance_node_id) {
      return NextResponse.json({
        success: false,
        error: { code: NODE_CONTEXT_REQUIRES_NODE, message: NODE_CONTEXT_REQUIRES_NODE_MESSAGE },
      }, { status: 400 });
    }

    // Validate credits PRE-FLIGHT before starting any workflow
    const site_id_for_validation = parsedBody.site_id || (parsedBody.instance_id ? (await supabaseAdmin.from('remote_instances').select('site_id').eq('id', parsedBody.instance_id).single()).data?.site_id : null);
    if (site_id_for_validation && !await canToolPrincipalAccessSite(principal, site_id_for_validation)) {
      return NextResponse.json({ error: 'Site access denied' }, { status: 403 });
    }
    
    const executionRouting = site_id_for_validation ? await admitAssistantRouting(site_id_for_validation) : undefined;
    if (site_id_for_validation && executionRouting) {
      const hasCredits = await validateAssistantInferenceAdmission(site_id_for_validation, executionRouting);
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
    const executionMode = resolveAssistantRequestMode(parsedBody.execution_mode, system_prompt);
    // Legacy node callers may send only shared output preferences in context.
    // Node execution is selected by the request-level node ID, not those fields.
    const normalizedToolOverrides = providedNodeId ? normalizePublishToolOverrides(
      parsedBody.context,
      parsedBody.tool_overrides,
    ) : parsedBody.tool_overrides;

    if (providedInstanceId && providedSiteId) {
      const { data: scope } = await supabaseAdmin.from('remote_instances')
        .select('site_id').eq('id', providedInstanceId).maybeSingle();
      if (scope && scope.site_id !== providedSiteId) {
        return NextResponse.json({ error: 'Instance does not belong to site' }, { status: 403 });
      }
    }
    const selectionSiteId = providedSiteId || site_id_for_validation;
    if (!selectionSiteId) return NextResponse.json({ error: 'site_id is required' }, { status: 400 });
    const verifiedUserId = principal.userId;
    const catalogUserSession = principal.userSession === true && !principal.internal && executionMode === 'direct' && !providedNodeId && expectedResults === 1;
    if (catalogUserSession && !parsedBody.request_id) {
      return NextResponse.json({ success: false, execution_started: false, error: {
        code: 'ASSISTANT_REQUEST_ID_REQUIRED', message: 'A request ID is required for an interactive Ask submission.',
      } }, { status: 400 });
    }
    const leadBulkUserSession = principal.userSession === true && !principal.internal && !providedNodeId && expectedResults === 1;
    const leadBulkAdmission = leadBulkUserSession ? { lead_bulk_user_session: true } : {};
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

    let instanceId = providedInstanceId;
    let siteId = selectionSiteId;
    let userId: string | undefined;
    let instanceStatus: string | undefined;
    let created = false;
    let observeFirstSend = false;
    const connectorIdHint = parsedBody.connector_id_hint;

    if (!instanceId) {
      const { data: site, error } = await supabaseAdmin.from('sites').select('id,user_id').eq('id', siteId).single();
      if (error || !site) return NextResponse.json({ error: 'Site not found' }, { status: 404 });
      siteId = site.id;
      userId = principal.internal ? providedUserId || site.user_id : principal.userId!;
      if (!userId) return NextResponse.json({ error: 'Assistant actor unavailable' }, { status: 403 });
      const reservedId = parsedBody.request_id && firstAskInstanceId(siteId, userId, principal.internal, parsedBody.request_id);
      const inserted = await supabaseAdmin.from('remote_instances').insert({
        ...(reservedId ? { id: reservedId } : {}), name: 'Assistant Session', instance_type: 'ubuntu',
        status: 'uninstantiated', site_id: siteId, user_id: userId, created_by: userId, timeout_hours: 1,
      }).select('id').single();
      if (!inserted.error && inserted.data?.id && (!reservedId || inserted.data.id === reservedId)) {
        instanceId = inserted.data.id;
        created = true;
      } else if (reservedId && inserted.error?.code === '23505') {
        // A concurrent creation must pass existing-row authorization as well.
        instanceId = reservedId;
        observeFirstSend = true;
      } else {
        throw new AskSubmissionError('ASSISTANT_ADMISSION_UNCONFIRMED');
      }
    }
    if (!instanceId) throw new AskSubmissionError('ASSISTANT_ADMISSION_UNCONFIRMED');

    if (!created) {
      const { data: instance, error } = await supabaseAdmin.from('remote_instances')
        .select('site_id, user_id, status, is_archived').eq('id', instanceId).single();
      if (error || !instance || !site_id_for_validation || instance.site_id !== site_id_for_validation ||
          (!providedInstanceId && instance.user_id !== userId)) {
        return NextResponse.json({ error: 'Instance not found' }, { status: 404 });
      }
      const rowAccess = await assistantInstanceAccess(request, principal, { ...instance, id: instanceId });
      if (rowAccess !== 200) return NextResponse.json({ error: rowAccess === 503 ? 'Instance verification unavailable' : 'Instance unavailable' }, { status: rowAccess });
      if (instance.is_archived === true) throw new Error('instance_archived');
      siteId = instance.site_id;
      userId = principal.internal ? providedUserId || instance.user_id : principal.userId!;
      instanceStatus = instance.status || 'running';
      if (connectorIdHint) {
        if (instance.user_id !== principal.userId) {
          return NextResponse.json({ error: 'Selected account unavailable for this conversation.' }, { status: 403 });
        }
        const { getVisibleConnector } = await import('@/lib/connectors/account-access');
        try { await getVisibleConnector(siteId, principal.userId!, connectorIdHint); }
        catch (error) {
          const { ConnectorError } = await import('@/lib/connectors/types');
          const status = error instanceof ConnectorError && error.status < 500 ? 404 : 503;
          return NextResponse.json({ error: 'Selected account unavailable for this conversation.' }, { status });
        }
      }
    }
    if (!userId) return NextResponse.json({ error: 'Assistant actor unavailable' }, { status: 403 });
    const userAction = await claimAskSubmission({ instanceId, siteId, userId, principal, body: parsedBody, observeFirstSend, connectionPolicy: catalogUserSession,
      details: { ...leadBulkAdmission, ...(providedInstanceId ? { instance_status: instanceStatus } : { is_creation: true }),
        status: 'running', instance_node_id: providedNodeId, execution_mode: executionMode } });
    const turn = { instance_id: instanceId, user_log_id: userAction.id };
    if (userAction.replay) {
      // A durable admission is not a workflow result. Never start/join by
      // timestamps, trust an unverified run ID, or return a previous answer.
      return NextResponse.json({ replayed: true, ...turn, action_status: userAction.status,
        code: 'ASSISTANT_REQUEST_RECORDED' }, { status: 202, headers: { 'Cache-Control': 'private, no-store' } });
    }
    claimedTurn = turn;
    // Persisting a conversational turn must not implicitly resume plans or advance
    // requirement execution, even for its owner. Changes and explicit retries go
    // through the requirements command queue, which arbitrates execution claims.
    // Start the interactive workflow with the trusted action identity only.
    const workflowRun = await start(runAssistantWorkflow, [
      instanceId,
      message,
      siteId,
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
      { selectedSkills, approvedImport, userMessageLogId: userAction.id, executionMode, executionRouting,
        ...(connectorIdHint ? { connectorIdHint } : {}), callerSource: principal.internal ? 'background' : 'interactive',
        ...(catalogUserSession ? { catalogUserSession: true } : {}), ...(leadBulkUserSession ? { leadBulkUserSession: true } : {}) }
    ]);

    return assistantResponseStream(workflowRun, instanceId, userAction.id, { signal: request.signal });

  } catch (err: any) {
    if (claimedTurn) {
      // The workflow SDK has no idempotency key. A rejected start may have
      // committed: do not retry, mark the owner failed, or invite another send.
      return NextResponse.json({ success: false, ...claimedTurn, error: { code: 'ASSISTANT_START_UNCONFIRMED',
        message: 'The assistant turn was recorded but its start could not be confirmed. Check this conversation before sending again.' } }, { status: 503 });
    }
    if (err instanceof Error && err.message.includes('instance_archived')) {
      // The database admission guard covers archival racing the preflight read.
      // Do not revive or mark the archived owner as failed after reassignment.
      return NextResponse.json({ success: false,
        error: { code: 'INSTANCE_ARCHIVED', message: 'This instance is archived. Continue in the requirement’s active instance.' },
      }, { status: 409 });
    }
    if (err instanceof Error && err.message.includes('requirement_execution_busy')) {
      // Admission was rejected before inserting the user action. Do not mark
      // the healthy owner as failed or retry by creating another instance.
      return NextResponse.json({
        success: false,
        error: { code: 'REQUIREMENT_EXECUTION_BUSY', message: 'This instance is already executing the requirement. Wait for the current cycle to finish before sending another instruction.' },
      }, { status: 409 });
    }
    if (err instanceof AskSubmissionError) {
      return NextResponse.json({ success: false, error: { code: err.code, message: err.message } },
        { status: err.code === 'ASSISTANT_REQUEST_CONFLICT' ? 409 : 503 });
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
