/**
 * Instance Validator Service
 * Handles instance state validation and plan status checks
 */

import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/database/supabase-client';
// Using REST resume endpoint; SDK may not expose resume on client

/**
 * Verify instance is running and handle non-running states
 */
export async function verifyInstanceRunning(
  instance: any,
  instance_id: string,
  instance_plan_id?: string
) {
  console.log(`₍ᐢ•(ܫ)•ᐢ₎ Verifying remote instance state: ${instance.status}`);
  
  // If instance is not running, verify plan state before deciding what to do
  if (instance.status !== 'running') {
    console.log(`₍ᐢ•(ܫ)•ᐢ₎ ⚠️ Instance not running (status: ${instance.status})`);
    
    // Attempt automatic resume when paused
    if (instance.status === 'paused') {
      try {
        const providerId = instance.provider_instance_id || instance_id;
        console.log(`₍ᐢ•(ܫ)•ᐢ₎ Attempting to resume paused instance: ${providerId}`);
        const apiKey = process.env.SCRAPYBARA_API_KEY || '';
        const resumeResp = await fetch(`https://api.scrapybara.com/v1/instance/${providerId}/resume`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
          },
          body: JSON.stringify({ timeout_hours: instance.timeout_hours || 1 }),
        });
        if (!resumeResp.ok) {
          const errText = await resumeResp.text();
          throw new Error(`Resume failed: ${resumeResp.status} ${errText}`);
        }

        // Update DB optimistically to running
        await supabaseAdmin
          .from('remote_instances')
          .update({ status: 'running', updated_at: new Date().toISOString() })
          .eq('id', instance_id);

        console.log(`₍ᐢ•(ܫ)•ᐢ₎ ✅ Instance resumed successfully, proceeding with execution`);
        return null; // Continue execution after resume
      } catch (resumeError: any) {
        console.warn(`₍ᐢ•(ܫ)•ᐢ₎ ⚠️ Failed to resume paused instance: ${resumeError?.message || resumeError}`);
        // Fall through to plan status handling below
      }
    }
    
    // Get plan to determine if completed or not
    let planForStatusCheck;
    if (instance_plan_id) {
      const planResult = await supabaseAdmin
        .from('instance_plans')
        .select('*')
        .eq('id', instance_plan_id)
        .single();
      planForStatusCheck = planResult.data;
    } else {
      // Find most recent plan for this instance
      const planResult = await supabaseAdmin
        .from('instance_plans')
        .select('*')
        .eq('instance_id', instance_id)
        .order('created_at', { ascending: false })
        .limit(1)
        .single();
      planForStatusCheck = planResult.data;
    }
    
    if (planForStatusCheck) {
      // Check if plan was already completed
      if (planForStatusCheck.status === 'completed') {
        console.log(`₍ᐢ•(ܫ)•ᐢ₎ ✅ Plan already completed, returning current state`);
        return NextResponse.json({ 
          data: {
            waiting_for_instructions: true,
            plan_completed: true,
            message: `Plan already completed. Instance is ${instance.status}.`,
            plan_progress: {
              completed_steps: planForStatusCheck.steps_completed || 0,
              total_steps: planForStatusCheck.steps_total || 0,
              percentage: planForStatusCheck.progress_percentage || 100
            },
            instance_status: instance.status,
            plan_status: planForStatusCheck.status
          }
        }, { status: 200 });
      } else {
        // Plan incomplete and instance stopped - mark plan as failed
        console.log(`₍ᐢ•(ܫ)•ᐢ₎ ❌ Plan incomplete and instance stopped, marking plan as failed`);
        
        await supabaseAdmin
          .from('instance_plans')
          .update({ 
            status: 'failed',
            error_message: `Instance is ${instance.status}, cannot continue plan execution`,
            updated_at: new Date().toISOString()
          })
          .eq('id', planForStatusCheck.id);
        
        return NextResponse.json({ 
          data: {
            waiting_for_instructions: false,
            plan_completed: false,
            plan_failed: true,
            message: `Plan marked as failed. Instance is ${instance.status} and plan was incomplete.`,
            failure_reason: `Instance is ${instance.status}, cannot continue plan execution`,
            plan_progress: {
              completed_steps: planForStatusCheck.steps_completed || 0,
              total_steps: planForStatusCheck.steps_total || 0,
              percentage: planForStatusCheck.progress_percentage || 0
            },
            instance_status: instance.status,
            plan_status: 'failed'
          }
        }, { status: 200 });
      }
    } else {
      // No plan, but instance not running
      console.log(`₍ᐢ•(ܫ)•ᐢ₎ ⚠️ No plan and instance not running`);
      return NextResponse.json({ 
        data: {
          waiting_for_instructions: true,
          plan_completed: false,
          message: `No plan found and instance is ${instance.status}`,
          instance_status: instance.status
        }
      }, { status: 200 });
    }
  }
  
  console.log(`₍ᐢ•(ܫ)•ᐢ₎ ✅ Instance verified in running state, continuing with execution`);
  return null; // null means continue with execution
}
