import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { provisionScrapybaraInstance, needsProvisioning } from '@/lib/services/robot-instance/instance-provisioner';

export async function preparePlanInstance(instance: any, instance_id: string, user_instruction?: string) {
    // 1.5. Check if instance is uninstantiated and needs provisioning
    if (needsProvisioning(instance)) {
      console.log(`₍ᐢ•(ܫ)•ᐢ₎ Instance is uninstantiated, provisioning Scrapybara instance...`);
      try {
        const provisionResult = await provisionScrapybaraInstance(
          instance_id,
          instance.site_id,
          instance.timeout_hours || 1
        );

        // Update local instance object with provisioned data
        instance.provider_instance_id = provisionResult.provider_instance_id;
        instance.cdp_url = provisionResult.cdp_url;
        instance.status = 'running';

        console.log(`₍ᐢ•(ܫ)•ᐢ₎ ✅ Instance provisioned successfully: ${provisionResult.provider_instance_id}`);
      } catch (provisionError: any) {
        return NextResponse.json({
          error: 'Failed to provision instance',
          details: provisionError.message,
          instance_id
        }, { status: 500 });
      }
    }

    // 2. If there's a new user instruction and instance is paused, resume it explicitly
    if (user_instruction && user_instruction.trim() && instance.status === 'paused') {
      try {
        const providerId = instance.provider_instance_id || instance_id;
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
        await supabaseAdmin
          .from('remote_instances')
          .update({ status: 'running', updated_at: new Date().toISOString() })
          .eq('id', instance_id);
        instance.status = 'running';
      } catch (resumeError: any) {
        return NextResponse.json({
          error: 'Failed to resume paused instance',
          details: resumeError instanceof Error ? resumeError.message : String(resumeError),
          instance_id
        }, { status: 500 });
      }
    }


    return null;
}
