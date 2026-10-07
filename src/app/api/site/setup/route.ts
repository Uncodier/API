import { NextRequest, NextResponse } from 'next/server';
import { WorkflowService } from '@/lib/services/workflow-service';
import { authenticateSetupUser, authorizeSetupManager } from './setup-access';
import { initializeSetupBilling, persistSetupLocale } from './setup-initialization';
import { parseSetupRequest, parseSetupWorkflowId, SiteSetupError } from './setup-request';
import { readSetupFeedback, withinSetupDeadline } from './setup-feedback';

export const maxDuration = 30;

function errorResponse(error: unknown) {
  if (error instanceof SiteSetupError) {
    return NextResponse.json(
      { success: false, error: { code: error.code, message: error.message } },
      { status: error.status, headers: { 'Cache-Control': 'private, no-store' } },
    );
  }
  console.error('[Site setup] Request failed');
  return NextResponse.json(
    { success: false, error: { code: 'INTERNAL_SERVER_ERROR', message: 'Unable to process site setup' } },
    { status: 500, headers: { 'Cache-Control': 'private, no-store' } },
  );
}

export async function POST(request: NextRequest) {
  let launchWorkflowId: string | undefined;
  try {
    const userId = await withinSetupDeadline(authenticateSetupUser(request), 3_000);
    const { site_id, user_id, setup_type, options } = await withinSetupDeadline(parseSetupRequest(request), 1_000);
    if (user_id && user_id !== userId) {
      throw new SiteSetupError(403, 'FORBIDDEN', 'user_id must match the authenticated user');
    }
    await withinSetupDeadline(authorizeSetupManager(site_id, userId), 3_000);

    const locale = options?.default_language || options?.default_locale || 'en';
    const defaultLocale = ['en', 'es', 'fr', 'de', 'ja'].includes(locale) ? locale : 'en';
    try {
      await withinSetupDeadline(initializeSetupBilling(site_id), 3_000);
    } catch (error) {
      if (error instanceof SiteSetupError && error.code === 'SETUP_UNCONFIRMED') {
        throw new SiteSetupError(503, 'BILLING_INITIALIZATION_FAILED',
          'Site billing could not be initialized. Please retry setup later');
      }
      throw error;
    }
    // Locale remains best-effort and cannot indefinitely prevent dispatch.
    if (options?.default_language || options?.default_locale) {
      await withinSetupDeadline(persistSetupLocale(site_id, defaultLocale), 1_000).catch(() => {});
    }

    const workflowArgs = {
      site_id,
      user_id: userId,
      setup_type,
      options: {
        ...options,
        enable_analytics: options?.enable_analytics !== false,
        enable_chat: options?.enable_chat !== false,
        enable_leads: options?.enable_leads !== false,
        enable_email_tracking: options?.enable_email_tracking !== false,
        default_timezone: options?.default_timezone || 'UTC',
        default_language: defaultLocale,
      },
    };
    launchWorkflowId = `site-setup-${site_id}-${Date.now()}`;
    const result = await withinSetupDeadline(WorkflowService.getInstance().executeWorkflow(
      'siteSetupWorkflow',
      workflowArgs,
      {
        // Match the queue subscribed by the existing Workflows worker.
        taskQueue: process.env.WORKFLOW_TASK_QUEUE || 'default',
        workflowId: launchWorkflowId,
        async: true,
      },
    ));
    if (!result.success || result.workflowId !== launchWorkflowId) {
      throw new SiteSetupError(
        500,
        'WORKFLOW_EXECUTION_ERROR',
        'Unable to start the site setup workflow',
      );
    }
    return NextResponse.json({
      success: true,
      data: {
        workflow_id: result.workflowId,
        execution_id: result.executionId,
        run_id: result.runId,
        status: 'accepted',
        setup_status: 'pending',
        cause: 'WORKFLOW_ACCEPTED',
        site_id,
        setup_type,
        message: 'Site setup was accepted. Completion is not yet confirmed.',
      },
    }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    if (launchWorkflowId) {
      return NextResponse.json({ success: false,
        error: { code: 'SETUP_UNCONFIRMED', message: 'Site setup could not be confirmed. Check its status before retrying.' },
        data: { workflow_id: launchWorkflowId, setup_status: 'unconfirmed', cause: 'WORKFLOW_START_UNCONFIRMED' },
      }, { status: 503, headers: { 'Cache-Control': 'private, no-store' } });
    }
    return errorResponse(error);
  }
}

export async function GET(request: NextRequest) {
  try {
    const userId = await withinSetupDeadline(authenticateSetupUser(request), 3_000);
    const { workflowId, siteId } = parseSetupWorkflowId(request);
    await withinSetupDeadline(authorizeSetupManager(siteId, userId), 3_000);
    const feedback = await readSetupFeedback(workflowId);
    return NextResponse.json({
      success: true,
      data: {
        ...feedback,
        site_id: siteId,
      },
    }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    return errorResponse(error);
  }
}