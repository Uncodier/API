import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { deleteRemoteInstanceChildren } from '@/lib/services/robot-instance/delete-remote-instance-children';

// ------------------------------------------------------------------------------------
// POST /api/robots/instance/delete
// Stop instance in Scrapybara and delete the instance record from database
// ------------------------------------------------------------------------------------

export const maxDuration = 120; // batched cleanup of logs/assets can take longer than a single DB statement

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

    // 2) Stop/terminate in Scrapybara (only if instance exists and not already stopped) -------------------
    let scrapybaraStopped = false;
    
    // Only try to stop in Scrapybara if we have a provider_instance_id and it's not already stopped
    if (instance.provider_instance_id && instance.status !== 'uninstantiated' && instance.status !== 'stopped') {
      console.log(`₍ᐢ•(ܫ)•ᐢ₎ Stopping Scrapybara instance: ${instance.provider_instance_id}`);
      
      const stopResponse = await fetch(
        `https://api.scrapybara.com/v1/instance/${instance.provider_instance_id}/stop`,
        {
          method: 'POST',
          headers: {
            'x-api-key': process.env.SCRAPYBARA_API_KEY || '',
            'Content-Type': 'application/json',
          },
        },
      );

      if (stopResponse.ok) {
        scrapybaraStopped = true;
        console.log(`₍ᐢ•(ܫ)•ᐢ₎ ✅ Scrapybara instance stopped successfully`);
      } else {
        const errorText = await stopResponse.text();
        console.error('Error stopping/terminating instance in Scrapybara:', errorText);
        // Continue anyway - we'll still mark as stopped in DB
        console.log(`₍ᐢ•(ܫ)•ᐢ₎ ⚠️ Scrapybara stop failed, but continuing with DB cleanup`);
      }
    } else {
      console.log(`₍ᐢ•(ܫ)•ᐢ₎ Instance is uninstantiated or has no provider_instance_id, skipping Scrapybara stop`);
    }

    // 3) Mark in-progress/paused plans as failed before deletion -------------------
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
          error_message: 'Instance was deleted',
          updated_at: new Date().toISOString(),
        })
        .eq('instance_id', instance_id)
        .in('status', ['in_progress', 'paused']);
    }

    // 4) Remove dependent rows (logs, nodes, assets, plans, etc.) so the parent delete stays under DB timeouts
    const childCleanup = await deleteRemoteInstanceChildren(instance_id);
    if (!childCleanup.ok) {
      console.error('Error cleaning up instance dependents:', childCleanup.error);
      return NextResponse.json(
        { error: childCleanup.error ?? 'Failed to remove instance-related data' },
        { status: 500 },
      );
    }

    // 5) Delete instance record from DB ---------------------------------------------
    const { error: deleteError } = await supabaseAdmin
      .from('remote_instances')
      .delete()
      .eq('id', instance_id);

    if (deleteError) {
      console.error('Error deleting instance from database:', deleteError);
      return NextResponse.json({ error: 'Failed to delete instance from database' }, { status: 500 });
    }

    return NextResponse.json(
      {
        instance_id,
        provider_instance_id: instance.provider_instance_id,
        message: scrapybaraStopped 
          ? 'Instance stopped in Scrapybara and deleted from database successfully' 
          : 'Instance deleted from database (no Scrapybara instance to stop)',
        scrapybara_stopped: scrapybaraStopped,
        affected_plans: affectedPlans?.length || 0,
      },
      { status: 200 },
    );
  } catch (err: any) {
    console.error('Error in POST /robots/instance/delete:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}



