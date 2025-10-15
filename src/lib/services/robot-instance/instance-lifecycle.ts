import { supabaseAdmin } from '@/lib/database/supabase-client';
import { ScrapybaraClient } from 'scrapybara';

type CreateOrResumeParams = {
  siteId?: string;
  activity?: string;
  instanceId?: string; // internal id (UUID) of remote_instances
};

type CreateOrResumeResult = {
  instanceRecord: any;
  justCreated: boolean;
  resumed: boolean;
};

async function resumeRemoteInstance(providerInstanceId: string, timeoutHours: number = 1): Promise<void> {
  const apiKey = process.env.SCRAPYBARA_API_KEY || '';
  if (!apiKey) throw new Error('SCRAPYBARA_API_KEY not configured');

  const resumeResp = await fetch(`https://api.scrapybara.com/v1/instance/${providerInstanceId}/resume`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
    },
    body: JSON.stringify({ timeout_hours: timeoutHours }),
  });
  if (!resumeResp.ok) {
    const errText = await resumeResp.text();
    throw new Error(`Resume failed: ${resumeResp.status} ${errText}`);
  }
}

async function createNewUbuntuInstance(siteId: string, activity: string): Promise<{ dbRecord: any }> {
  // Find user_id for site to persist the instance
  const { data: site, error: siteError } = await supabaseAdmin
    .from('sites')
    .select('user_id')
    .eq('id', siteId)
    .single();

  if (siteError || !site) {
    throw new Error('Site not found');
  }

  const client = new ScrapybaraClient({ apiKey: process.env.SCRAPYBARA_API_KEY || '' });
  const remoteInstance = await client.startUbuntu({ timeoutHours: 1 });
  const browserStartResult = await remoteInstance.browser.start();
  const cdpUrl = browserStartResult.cdpUrl;

  const { data: instanceRecord, error: instanceError } = await supabaseAdmin
    .from('remote_instances')
    .insert({
      name: activity,
      instance_type: 'ubuntu',
      status: 'running',
      provider_instance_id: remoteInstance.id,
      cdp_url: cdpUrl,
      timeout_hours: 1,
      site_id: siteId,
      user_id: site.user_id,
      created_by: site.user_id,
    })
    .select()
    .single();

  if (instanceError) {
    throw new Error(`Error saving instance: ${instanceError.message || instanceError}`);
  }

  return { dbRecord: instanceRecord };
}

export async function createOrResumeInstance(params: CreateOrResumeParams): Promise<CreateOrResumeResult> {
  const { siteId, activity, instanceId } = params;

  // 1) If instanceId provided, fetch by id and try resume if paused
  if (instanceId) {
    const { data: instance, error } = await supabaseAdmin
      .from('remote_instances')
      .select('*')
      .eq('id', instanceId)
      .single();

    if (error || !instance) {
      throw new Error('Instance not found');
    }

    let resumed = false;
    if (instance.status === 'paused' && instance.provider_instance_id) {
      try {
        await resumeRemoteInstance(instance.provider_instance_id, instance.timeout_hours || 1);
        await supabaseAdmin
          .from('remote_instances')
          .update({ status: 'running', updated_at: new Date().toISOString() })
          .eq('id', instance.id);
        instance.status = 'running';
        resumed = true;
      } catch (err) {
        // keep original status if resume fails
      }
    }

    return { instanceRecord: instance, justCreated: false, resumed };
  }

  // 2) Without instanceId, require siteId + activity to create new instance
  if (!siteId || !activity) {
    throw new Error('siteId and activity are required when instanceId is not provided');
  }

  // Always create new instance - no longer search for existing instances by activity
  // Instances are now paused/deleted in a controlled manner, and resume should be used explicitly
  const { dbRecord } = await createNewUbuntuInstance(siteId, activity);
  return { instanceRecord: dbRecord, justCreated: true, resumed: false };
}


