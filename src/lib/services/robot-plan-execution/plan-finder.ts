/**
 * Plan Finder Service
 * Handles finding and validating plans for execution
 */

import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/database/supabase-client';

/**
 * Find plan for execution
 */
export async function findPlanForExecution(
  instance_id: string,
  instance_plan_id?: string
): Promise<{ plan: any; error: NextResponse | null }> {
  let planError;
  let plan = null;
  
  console.log(`₍ᐢ•(ܫ)•ᐢ₎ 🔍 Looking for plan - instance_plan_id: ${instance_plan_id || 'not provided'}, instance_id: ${instance_id}`);
  
  if (instance_plan_id) {
    console.log(`₍ᐢ•(ܫ)•ᐢ₎ 🔍 Looking for specific plan by ID: ${instance_plan_id}`);
    const planResult = await supabaseAdmin
      .from('instance_plans')
      .select('*')
      .eq('id', instance_plan_id)
      .single();
    plan = planResult.data;
    planError = planResult.error;
    console.log(`₍ᐢ•(ܫ)•ᐢ₎ 🔍 Search result by ID - plan found: ${!!plan}, error: ${planError?.message || 'none'}`);
  } else {
    // Find most recent active plan for this instance
    console.log(`₍ᐢ•(ܫ)•ᐢ₎ 🔍 Looking for most recent active plan for instance_id: ${instance_id}`);
    const planResult = await supabaseAdmin
      .from('instance_plans')
      .select('*')
      .eq('instance_id', instance_id)
      .in('status', ['active', 'pending', 'in_progress', 'paused'])
      .order('created_at', { ascending: false })
      .limit(1)
      .single();
    plan = planResult.data;
    planError = planResult.error;
    console.log(`₍ᐢ•(ܫ)•ᐢ₎ 🔍 Active search result - plan found: ${!!plan}, status: ${plan?.status || 'none'}, error: ${planError?.message || 'none'}`);
    
    // If no active plan found, look for any plan for diagnostics
    if (!plan) {
      console.log(`₍ᐢ•(ܫ)•ᐢ₎ 🔍 No active plan found, looking for ANY plan for diagnostics...`);
      const allPlansResult = await supabaseAdmin
        .from('instance_plans')
        .select('id, status, title, created_at')
        .eq('instance_id', instance_id)
        .order('created_at', { ascending: false });
      
      console.log(`₍ᐢ•(ܫ)•ᐢ₎ 🔍 Plans found for instance_id ${instance_id}:`, allPlansResult.data);
    }
  }

  if (planError || !plan) {
    console.log(`₍ᐢ•(ܫ)•ᐢ₎ ❌ No active plan found, attempting broad search...`);
    
    // Fallback search: look for any plan for this instance (even completed/failed)
    const fallbackResult = await supabaseAdmin
      .from('instance_plans')
      .select('*')
      .eq('instance_id', instance_id)
      .order('created_at', { ascending: false })
      .limit(1)
      .single();
    
    if (fallbackResult.data) {
      console.log(`₍ᐢ•(ܫ)•ᐢ₎ 🔍 Plan found in broad search: ${fallbackResult.data.id}, status: ${fallbackResult.data.status}`);
      
      // If plan is completed, inform user
      if (fallbackResult.data.status === 'completed') {
        return {
          plan: null,
          error: NextResponse.json({ 
            data: {
              waiting_for_instructions: true,
              plan_completed: true,
              message: `Plan "${fallbackResult.data.title}" was already completed`,
              plan_id: fallbackResult.data.id,
              plan_status: fallbackResult.data.status
            }
          }, { status: 200 })
        };
      }
      
      // If plan failed, inform user
      if (fallbackResult.data.status === 'failed') {
        return {
          plan: null,
          error: NextResponse.json({ 
            data: {
              waiting_for_instructions: true,
              plan_completed: false,
              plan_failed: true,
              message: `Plan "${fallbackResult.data.title}" has failed. Reason: ${fallbackResult.data.failure_reason || 'Unknown'}`,
              plan_id: fallbackResult.data.id,
              plan_status: fallbackResult.data.status
            }
          }, { status: 200 })
        };
      }
      
      // If plan has other status, try reactivating
      console.log(`₍ᐢ•(ܫ)•ᐢ₎ 🔄 Attempting to reactivate plan with status: ${fallbackResult.data.status}`);
      plan = fallbackResult.data;
    } else {
      console.log(`₍ᐢ•(ܫ)•ᐢ₎ ❌ No plan found at all for instance_id: ${instance_id}`);
      return {
        plan: null,
        error: NextResponse.json({ 
          data: {
            waiting_for_instructions: true,
            plan_completed: false,
            message: 'No plan found for this instance'
          }
        }, { status: 200 })
      };
    }
  }

  return { plan, error: null };
}
