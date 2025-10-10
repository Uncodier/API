import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { supabaseAdmin } from '@/lib/database/supabase-client';

// ------------------------------------------------------------------------------------
// POST /api/robots/instance/delete
// Fully stop/terminate a remote instance in Scrapybara and update DB status
// ------------------------------------------------------------------------------------

export const maxDuration = 60; // 1 minute

const DeleteInstanceSchema = z.object({
  instance_id: z.string().uuid('instance_id must be a valid UUID'),
});

export async function POST(request: NextRequest) {
  try {
    const rawBody = await request.json();
    const { instance_id } = DeleteInstanceSchema.parse(rawBody);

    // 1) Fetch instance from DB ------------------------------------------------------
    const { data: instance, error: instanceError } = await supabaseAdmin
      .from('remote_instances')
      .select('*')
      .eq('id', instance_id)
      .single();

    if (instanceError || !instance) {
      return NextResponse.json({ error: 'Instance not found' }, { status: 404 });
    }

    // Idempotency: if already stopped, return OK
    if (instance.status === 'stopped') {
      return NextResponse.json(
        { instance_id, status: 'stopped', message: 'Instance already stopped' },
        { status: 200 },
      );
    }

    // 2) Stop/terminate in Scrapybara ----------------------------------------------
    const scrapybaraInstanceId = instance.provider_instance_id ?? instance.id;

    const stopResponse = await fetch(
      `https://api.scrapybara.com/v1/instance/${scrapybaraInstanceId}/stop`,
      {
        method: 'POST',
        headers: {
          'x-api-key': process.env.SCRAPYBARA_API_KEY || '',
          'Content-Type': 'application/json',
        },
      },
    );

    if (!stopResponse.ok) {
      const errorText = await stopResponse.text();
      console.error('Error stopping/terminating instance in Scrapybara:', errorText);
      return NextResponse.json(
        { error: `Failed to stop instance: ${stopResponse.status} ${errorText}` },
        { status: 500 },
      );
    }

    // 3) Update DB status -----------------------------------------------------------
    const { error: updateError } = await supabaseAdmin
      .from('remote_instances')
      .update({ status: 'stopped', updated_at: new Date().toISOString() })
      .eq('id', instance_id);

    if (updateError) {
      console.error('Error updating instance status:', updateError);
      return NextResponse.json({ error: 'Failed to update instance status' }, { status: 500 });
    }

    // 4) Mark in-progress/paused plans as failed -----------------------------------
    const { data: affectedPlans } = await supabaseAdmin
      .from('instance_plans')
      .select('id, title')
      .eq('instance_id', instance_id)
      .in('status', ['in_progress', 'paused']);

    if (affectedPlans && affectedPlans.length > 0) {
      await supabaseAdmin
        .from('instance_plans')
        .update({
          status: 'failed',
          error_message: 'Instance was terminated',
          updated_at: new Date().toISOString(),
        })
        .eq('instance_id', instance_id)
        .in('status', ['in_progress', 'paused']);
    }

    return NextResponse.json(
      {
        instance_id,
        provider_instance_id: instance.provider_instance_id,
        status: 'stopped',
        message: 'Instance stopped and destroyed successfully',
        affected_plans: affectedPlans?.length || 0,
      },
      { status: 200 },
    );
  } catch (err: any) {
    console.error('Error in POST /robots/instance/delete:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}



