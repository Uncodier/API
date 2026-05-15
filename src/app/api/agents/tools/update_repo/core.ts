/**
 * Core implementation for the update_repo tool
 */

import { supabaseAdmin } from '@/lib/database/supabase-client';
import { start } from 'workflow/api';
import { runUpdateRepoWorkflow } from './workflow';

export interface UpdateRepoParams {
  site_id: string;
  instance_id: string;
  user_id: string;
  requirement_id: string;
  instruction: string;
}

export async function updateRepoCore(params: UpdateRepoParams) {
  try {
    const { site_id, instance_id, user_id, requirement_id, instruction } = params;

    // 1. Verify requirement exists and belongs to the site
    const { data: requirement, error: reqError } = await supabaseAdmin
      .from('requirements')
      .select('id, title, type')
      .eq('id', requirement_id)
      .eq('site_id', site_id)
      .single();

    if (reqError || !requirement) {
      throw new Error(`Requirement ${requirement_id} not found or access denied`);
    }

    // 2. Log the tool call
    await supabaseAdmin.from('instance_logs').insert({
      instance_id,
      site_id,
      user_id,
      log_type: 'tool_call',
      level: 'info',
      message: `Triggering update_repo workflow for requirement ${requirement_id}`,
      details: {
        tool_name: 'update_repo',
        instruction,
        requirement_id
      }
    });

    // 3. Start the workflow
    // The workflow will handle creating the sandbox, running the agent, and pushing changes
    const workflowRun = await start(runUpdateRepoWorkflow, [{
      reqId: requirement_id,
      title: requirement.title,
      instruction,
      type: requirement.type || 'applications',
      site_id,
      user_id,
      instanceId: instance_id
    }]);

    return {
      success: true,
      message: `Update repository workflow started successfully. Changes will be pushed to the requirement branch.`,
      workflow_id: workflowRun.runId,
      requirement_id
    };
  } catch (error: any) {
    console.error(`[UpdateRepoCore] Error:`, error);
    
    // Log the error
    try {
      await supabaseAdmin.from('instance_logs').insert({
        instance_id: params.instance_id,
        site_id: params.site_id,
        user_id: params.user_id,
        log_type: 'error',
        level: 'error',
        message: `Failed to trigger update_repo workflow: ${error.message}`,
        details: { error: error.message || String(error) }
      });
    } catch (e) {}

    return { 
      success: false, 
      error: error.message || 'An unexpected error occurred while starting the update_repo workflow.' 
    };
  }
}
