import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/database/supabase-client';

/**
 * Verifies that both the plan and instance remain active and in progress
 * Returns an error response if either has changed state
 */
export async function verifyActiveStatus(
  instance_id: string,
  plan_id: string
): Promise<NextResponse | null> {
  // Check instance status
  const { data: instance, error: instanceError } = await supabaseAdmin
    .from('remote_instances')
    .select('status')
    .eq('id', instance_id)
    .single();

  if (instanceError || !instance) {
    return NextResponse.json(
      { error: 'Instance not found during status check', instance_id },
      { status: 404 }
    );
  }

  if (instance.status !== 'running') {
    return NextResponse.json(
      {
        data: {
          waiting_for_instructions: true,
          instance_stopped: instance.status !== 'paused',
          instance_paused: instance.status === 'paused',
          message: `Instance is ${instance.status}`,
          instance_id,
          current_status: instance.status,
          can_resume: instance.status === 'paused'
        }
      },
      { status: 200 }
    );
  }

  // Check plan status
  const { data: planData, error: planError } = await supabaseAdmin
    .from('instance_plans')
    .select('status')
    .eq('id', plan_id)
    .single();

  if (planError || !planData) {
    return NextResponse.json(
      { error: 'Plan not found during status check', plan_id },
      { status: 404 }
    );
  }

  // Handle paused status gracefully with 200 response
  if (planData.status === 'paused') {
    return NextResponse.json(
      {
        data: {
          waiting_for_instructions: true,
          plan_paused: true,
          message: 'Plan execution has been paused',
          plan_id,
          current_status: 'paused',
          can_resume: true
        }
      },
      { status: 200 }
    );
  }

  // Only return error for truly inactive states (completed, failed, canceled)
  if (planData.status !== 'in_progress' && planData.status !== 'pending') {
    return NextResponse.json(
      {
        data: {
          waiting_for_instructions: true,
          plan_completed: planData.status === 'completed',
          plan_failed: planData.status === 'failed',
          message: `Plan is ${planData.status}`,
          plan_id,
          current_status: planData.status
        }
      },
      { status: 200 }
    );
  }

  return null; // All good, continue execution
}
