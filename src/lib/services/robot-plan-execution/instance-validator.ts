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
    
    // Do NOT auto-resume when paused. Return waiting response and allow explicit resume elsewhere.
    if (instance.status === 'paused') {
      // Determine current or latest plan to include context in response
      let planForStatusCheck;
      if (instance_plan_id) {
        const planResult = await supabaseAdmin
          .from('instance_plans')
          .select('*')
          .eq('id', instance_plan_id)
          .single();
        planForStatusCheck = planResult.data;
      } else {
        const planResult = await supabaseAdmin
          .from('instance_plans')
          .select('*')
          .eq('instance_id', instance_id)
          .order('created_at', { ascending: false })
          .limit(1)
          .single();
        planForStatusCheck = planResult.data;
      }

      return NextResponse.json({
        data: {
          waiting_for_instructions: true,
          instance_paused: true,
          message: 'Instance is paused. Provide a new prompt to resume.',
          instance_status: 'paused',
          plan_status: planForStatusCheck?.status || null,
          plan_id: planForStatusCheck?.id || null,
          can_resume: true
        }
      }, { status: 200 });
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
