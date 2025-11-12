import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { markRunningPlansAsFailed } from '@/lib/helpers/plan-lifecycle';

// ------------------------------------------------------------------------------------
// POST /api/robots/instance/pause
// Pause a remote instance in Scrapybara and update DB status
// ------------------------------------------------------------------------------------

export const maxDuration = 60; // 1 minute

const PauseInstanceSchema = z.object({
  instance_id: z.string().uuid('instance_id must be a valid UUID'),
});

export async function POST(request: NextRequest) {
  try {
    const rawBody = await request.json();
    const { instance_id } = PauseInstanceSchema.parse(rawBody);

    // 1) Fetch instance from DB ------------------------------------------------------
    const { data: instance, error: instanceError } = await supabaseAdmin
      .from('remote_instances')
      .select('*')
      .eq('id', instance_id)
      .single();

    if (instanceError || !instance) {
      return NextResponse.json({ error: 'Instance not found' }, { status: 404 });
    }

    // Idempotency: if already paused, return OK
    if (instance.status === 'paused') {
      return NextResponse.json(
        { instance_id, status: 'paused', message: 'Instance already paused' },
        { status: 200 },
      );
    }

    // 2) Pause instance in Scrapybara (only if instance exists) -------------------
    const scrapybaraInstanceId = instance.provider_instance_id ?? instance.id;
    
    const pauseResponse = await fetch(
      `https://api.scrapybara.com/v1/instance/${scrapybaraInstanceId}/pause`,
      {
        method: 'POST',
        headers: {
          'x-api-key': process.env.SCRAPYBARA_API_KEY || '',
          'Content-Type': 'application/json',
        },
      },
    );

    if (!pauseResponse.ok) {
      const errorText = await pauseResponse.text();
      console.error('Error pausing instance in Scrapybara:', errorText);
      return NextResponse.json({ 
        error: `Error pausing instance: ${pauseResponse.status} ${errorText}` 
      }, { status: 500 });
    }

    // 3) Update DB status -----------------------------------------------------------
    const { error: updateError } = await supabaseAdmin
      .from('remote_instances')
      .update({ 
        status: 'paused',
        updated_at: new Date().toISOString()
      })
      .eq('id', instance_id);

    if (updateError) {
      console.error('Error updating instance status:', updateError);
      return NextResponse.json({ error: 'Failed to update instance status' }, { status: 500 });
    }

    // 4) Mark running plans as failed -----------------------------------------
    const failedPlansResult = await markRunningPlansAsFailed(
      instance_id,
      'Instance was paused while plan was in progress'
    );

    return NextResponse.json(
      {
        instance_id,
        status: 'paused',
        message: 'Instance paused successfully',
        affected_plans: failedPlansResult.completedCount,
        plan_failure_success: failedPlansResult.success,
        plan_failure_errors: failedPlansResult.errors,
      },
      { status: 200 },
    );
  } catch (err: any) {
    console.error('Error in POST /robots/instance/pause:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

