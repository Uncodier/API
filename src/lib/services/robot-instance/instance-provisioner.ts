/**
 * Instance Provisioner Service
 * Handles Scrapybara instance provisioning for uninstantiated instances
 */

import { ScrapybaraClient } from 'scrapybara';
import { supabaseAdmin } from '@/lib/database/supabase-client';

export interface ProvisionResult {
  provider_instance_id: string;
  cdp_url: string;
  remoteInstance: any;
}

/**
 * Provision a Scrapybara instance for an existing database record
 * Updates the instance record with provider_instance_id, cdp_url, and status
 */
export async function provisionScrapybaraInstance(
  instanceId: string,
  siteId: string,
  timeoutHours: number = 1
): Promise<ProvisionResult> {
  console.log(`₍ᐢ•(ܫ)•ᐢ₎ Provisioning Scrapybara instance for: ${instanceId}`);

  try {
    // Create Scrapybara client
    const client = new ScrapybaraClient({
      apiKey: process.env.SCRAPYBARA_API_KEY || '',
    });

    // Start Ubuntu instance
    const remoteInstance = await client.startUbuntu({ timeoutHours });
    console.log(`₍ᐢ•(ܫ)•ᐢ₎ Scrapybara instance started: ${remoteInstance.id}`);

    // Start browser and get CDP URL
    const browserStartResult = await remoteInstance.browser.start();
    const cdpUrl = browserStartResult.cdpUrl;
    console.log(`₍ᐢ•(ܫ)•ᐢ₎ Browser started with CDP URL: ${cdpUrl}`);

    // Update database record
    const { error: updateError } = await supabaseAdmin
      .from('remote_instances')
      .update({
        provider_instance_id: remoteInstance.id,
        cdp_url: cdpUrl,
        status: 'running',
        started_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', instanceId);

    if (updateError) {
      console.error(`₍ᐢ•(ܫ)•ᐢ₎ Error updating instance record:`, updateError);
      throw new Error(`Failed to update instance record: ${updateError.message}`);
    }

    console.log(`₍ᐢ•(ܫ)•ᐢ₎ ✅ Instance provisioned successfully: ${instanceId}`);

    return {
      provider_instance_id: remoteInstance.id,
      cdp_url: cdpUrl,
      remoteInstance,
    };
  } catch (error: any) {
    console.error(`₍ᐢ•(ܫ)•ᐢ₎ ❌ Error provisioning instance:`, error);
    
    // Update instance to error state
    await supabaseAdmin
      .from('remote_instances')
      .update({
        status: 'error',
        updated_at: new Date().toISOString(),
      })
      .eq('id', instanceId);

    throw new Error(`Failed to provision Scrapybara instance: ${error.message || error}`);
  }
}

/**
 * Check if instance needs provisioning (uninstantiated status)
 */
export function needsProvisioning(instance: any): boolean {
  return instance.status === 'uninstantiated';
}

