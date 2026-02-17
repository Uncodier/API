import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { start } from 'workflow/api';
import { runAssistantWorkflow } from './workflow';
import {
  generateAgentBackground,
  getAssistantTools,
  fetchMemoriesContext,
  ICP_CATEGORY_IDS_INSTRUCTION
} from './utils';
import { InstanceAssetsService } from '@/lib/services/robot-instance/InstanceAssetsService';
import { executeAssistant } from '@/lib/services/robot-instance/assistant-executor';

// ------------------------------------------------------------------------------------
// POST /api/robots/instance/assistant
// Assistant route that triggers a Vercel Workflow for execution
// ------------------------------------------------------------------------------------

export const maxDuration = 300; // 5 minutes

const AssistantSchema = z.object({
  instance_id: z.string().uuid('instance_id must be valid UUID').optional(),
  message: z.string().min(1, 'message is required'),
  site_id: z.string().min(1, 'site_id is required when creating new instance').optional(),
  user_id: z.string().uuid().optional(),
  tools: z.array(z.any()).optional().default([]),
  use_sdk_tools: z.boolean().optional().default(false),
  system_prompt: z.string().optional(),
});

export async function POST(request: NextRequest) {
  try {
    const rawBody = await request.json();
    console.log('🔍 Raw body received:', JSON.stringify(rawBody, null, 2));
    
    const {
      instance_id: providedInstanceId,
      message,
      site_id: providedSiteId,
      user_id: providedUserId,
      tools: customTools,
      use_sdk_tools,
      system_prompt,
    } = AssistantSchema.parse(rawBody);

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

      // Log user prompt
      await supabaseAdmin.from('instance_logs').insert({
        log_type: 'user_action',
        level: 'info',
        message: message,
        details: {
          prompt_source: 'assistant_route',
          is_creation: true,
        },
        instance_id: newInstance.id,
        site_id: providedSiteId,
        user_id: userId,
      });

      // Prepare context for immediate execution (avoiding workflow overhead for initial creation response if speed is preferred, 
      // but to be consistent with "use workflow", we could also use the workflow here. 
      // However, for the very first message, users often expect immediate feedback.
      // Let's use the workflow anyway to be "compatible with the framework" as requested.)
      
      const workflowRun = await start(runAssistantWorkflow, [
        newInstance.id,
        message,
        providedSiteId,
        userId,
        customTools,
        use_sdk_tools,
        system_prompt
      ]);

      // Return the run information. The frontend might need to poll or we stream.
      // However, since the user said "shouldn't change anything in front", 
      // we attempt to wait for the result using the `result()` method if available on the run object in newer SDKs, 
      // or we return the run ID and let the frontend adapt if needed. 
      // BUT, since we can't easily change the frontend right now, 
      // and Vercel Workflow is asynchronous...
      
      // OPTION: We wait for the result here manually by polling the workflow status?
      // No, that's inefficient.
      
      // Let's see if we can just return the result of the workflow by NOT using `start` but calling it directly?
      // No, `use workflow` functions MUST be called via `start`.
      
      // COMPROMISE: For now, we will return a response that LOOKS like the old one but with empty/processing status,
      // OR we implement a poor-man's polling here to wait for the result (up to a timeout).
      
      // Check if we can stream the result
      return new Response(workflowRun.readable, {
          status: 200,
          headers: {
              'Content-Type': 'text/event-stream',
              'X-Workflow-Run-Id': workflowRun.runId
          }
      });
    }

    // CASE 2: Existing instance_id provided - Execute via Workflow
    console.log(`₍ᐢ•(ܫ)•ᐢ₎ Executing on existing instance: ${providedInstanceId}`);

    // Get instance to verify existence and ownership
    const { data: instance, error: instanceError } = await supabaseAdmin
      .from('remote_instances')
      .select('site_id, user_id')
      .eq('id', providedInstanceId)
      .single();

    if (instanceError || !instance) {
      return NextResponse.json({ error: 'Instance not found' }, { status: 404 });
    }

    const site_id = providedSiteId || instance.site_id;
    const user_id = providedUserId || instance.user_id;

    // Log user prompt
    await supabaseAdmin.from('instance_logs').insert({
      log_type: 'user_action',
      level: 'info',
      message: message,
      details: {
        prompt_source: 'assistant_route',
        instance_status: 'running', // Will be checked in workflow
      },
      instance_id: providedInstanceId,
      site_id: site_id,
      user_id: user_id,
    });

    // Start the workflow
    const workflowRun = await start(runAssistantWorkflow, [
        providedInstanceId,
        message,
        site_id,
        user_id,
        customTools,
        use_sdk_tools,
        system_prompt
    ]);

    // Return stream response compatible with Vercel Workflow result streaming
    return new Response(workflowRun.readable, {
        status: 200,
        headers: {
            'Content-Type': 'text/event-stream',
            'X-Workflow-Run-Id': workflowRun.runId,
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
        }
    });

  } catch (err: any) {
    console.error('Error in POST /robots/instance/assistant:', err);
    
    return NextResponse.json({
      error: err.message || 'Failed to execute assistant',
      details: err.stack,
    }, { status: 500 });
  }
}
