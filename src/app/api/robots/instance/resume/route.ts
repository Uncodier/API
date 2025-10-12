import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { provisionScrapybaraInstance, needsProvisioning } from '@/lib/services/robot-instance/instance-provisioner';

// ------------------------------------------------------------------------------------
// POST /api/robots/instance/resume
// Resume a paused instance or create an uninstantiated instance
// ------------------------------------------------------------------------------------

export const maxDuration = 60; // 1 minute

const ResumeInstanceSchema = z.object({
  instance_id: z.string().uuid('instance_id must be a valid UUID'),
  timeout_hours: z.number().min(0.1).max(24).default(1).optional(),
});

export async function POST(request: NextRequest) {
  try {
    const rawBody = await request.json();
    const { instance_id, timeout_hours = 1 } = ResumeInstanceSchema.parse(rawBody);

    console.log(`₍ᐢ•(ܫ)•ᐢ₎ Resuming instance: ${instance_id}`);

    // 1. Fetch instance from database
    const { data: instance, error: instanceError } = await supabaseAdmin
      .from('remote_instances')
      .select('*')
      .eq('id', instance_id)
      .single();

    if (instanceError || !instance) {
      return NextResponse.json({ error: 'Instance not found' }, { status: 404 });
    }

    console.log(`₍ᐢ•(ܫ)•ᐢ₎ Instance status: ${instance.status}`);

    // 2. Handle different instance states
    if (instance.status === 'running') {
      return NextResponse.json({
        instance_id,
        status: 'running',
        message: 'Instance is already running',
        action_taken: 'none'
      }, { status: 200 });
    }

    if (instance.status === 'stopped' || instance.status === 'error') {
      return NextResponse.json({
        error: 'Cannot resume stopped or error instances',
        instance_id,
        current_status: instance.status
      }, { status: 400 });
    }

    let actionTaken = '';
    let providerInstanceId = instance.provider_instance_id;

    // 3. Handle uninstantiated instances (create new Scrapybara instance)
    if (needsProvisioning(instance)) {
      console.log(`₍ᐢ•(ܫ)•ᐢ₎ Instance is uninstantiated, provisioning new Scrapybara instance...`);
      
      try {
        const provisionResult = await provisionScrapybaraInstance(
          instance_id,
          instance.site_id,
          timeout_hours
        );
        
        providerInstanceId = provisionResult.provider_instance_id;
        actionTaken = 'provisioned';
        
        console.log(`₍ᐢ•(ܫ)•ᐢ₎ ✅ Instance provisioned successfully: ${providerInstanceId}`);
      } catch (provisionError: any) {
        console.error(`₍ᐢ•(ܫ)•ᐢ₎ ❌ Provisioning failed:`, provisionError);
        return NextResponse.json({
          error: 'Failed to provision instance',
          details: provisionError.message,
          instance_id
        }, { status: 500 });
      }
    }
    // 4. Handle paused instances (resume existing Scrapybara instance)
    else if (instance.status === 'paused') {
      console.log(`₍ᐢ•(ܫ)•ᐢ₎ Instance is paused, resuming Scrapybara instance...`);
      
      if (!providerInstanceId) {
        return NextResponse.json({
          error: 'Cannot resume paused instance without provider_instance_id',
          instance_id
        }, { status: 400 });
      }

      try {
        const resumeResponse = await fetch(
          `https://api.scrapybara.com/v1/instance/${providerInstanceId}/resume`,
          {
            method: 'POST',
            headers: {
              'x-api-key': process.env.SCRAPYBARA_API_KEY || '',
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ timeout_hours: timeout_hours }),
          }
        );

        if (!resumeResponse.ok) {
          const errorText = await resumeResponse.text();
          console.error('Error resuming instance in Scrapybara:', errorText);
          return NextResponse.json({
            error: `Failed to resume instance: ${resumeResponse.status} ${errorText}`,
            instance_id
          }, { status: 500 });
        }

        // Update instance status in database
        const { error: updateError } = await supabaseAdmin
          .from('remote_instances')
          .update({
            status: 'running',
            updated_at: new Date().toISOString()
          })
          .eq('id', instance_id);

        if (updateError) {
          console.error('Error updating instance status:', updateError);
          return NextResponse.json({
            error: 'Failed to update instance status',
            instance_id
          }, { status: 500 });
        }

        actionTaken = 'resumed';
        console.log(`₍ᐢ•(ܫ)•ᐢ₎ ✅ Instance resumed successfully`);
      } catch (resumeError: any) {
        console.error(`₍ᐢ•(ܫ)•ᐢ₎ ❌ Resume failed:`, resumeError);
        return NextResponse.json({
          error: 'Failed to resume instance',
          details: resumeError.message,
          instance_id
        }, { status: 500 });
      }
    }
    // 5. Handle other states (starting, stopping, etc.)
    else {
      return NextResponse.json({
        error: `Cannot resume instance in ${instance.status} state`,
        instance_id,
        current_status: instance.status,
        supported_states: ['paused', 'uninstantiated']
      }, { status: 400 });
    }

    // 6. Resume any paused plans for this instance
    const { data: pausedPlans } = await supabaseAdmin
      .from('instance_plans')
      .select('id, title')
      .eq('instance_id', instance_id)
      .eq('status', 'paused');

    if (pausedPlans && pausedPlans.length > 0) {
      console.log(`₍ᐢ•(ܫ)•ᐢ₎ Resuming ${pausedPlans.length} paused plan(s)`);
      
      await supabaseAdmin
        .from('instance_plans')
        .update({
          status: 'pending',
          updated_at: new Date().toISOString()
        })
        .eq('instance_id', instance_id)
        .eq('status', 'paused');
    }

    // 7. Log the resume action
    await supabaseAdmin.from('instance_logs').insert({
      log_type: 'system_action',
      level: 'info',
      message: `Instance ${actionTaken} successfully`,
      details: {
        action: actionTaken,
        provider_instance_id: providerInstanceId,
        timeout_hours: timeout_hours,
        resumed_plans: pausedPlans?.length || 0
      },
      instance_id: instance_id,
      site_id: instance.site_id,
      user_id: instance.user_id,
    });

    return NextResponse.json({
      instance_id,
      provider_instance_id: providerInstanceId,
      status: 'running',
      message: `Instance ${actionTaken} successfully`,
      action_taken: actionTaken,
      resumed_plans: pausedPlans?.length || 0,
      timeout_hours: timeout_hours
    }, { status: 200 });

  } catch (err: any) {
    console.error('Error in POST /robots/instance/resume:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
