/**
 * Instance Connection Service
 * Handles connection to Scrapybara instances, validation, and browser checks
 */

import { ScrapybaraClient } from 'scrapybara';
import { supabaseAdmin } from '@/lib/database/supabase-client';

/**
 * Connect to Scrapybara instance
 */
export async function connectToInstance(provider_instance_id: string) {
  console.log(`₍ᐢ•(ܫ)•ᐢ₎ About to connect to Scrapybara instance...`);
  console.log(`₍ᐢ•(ܫ)•ᐢ₎ Instance provider_instance_id: ${provider_instance_id}`);
  
  const client = new ScrapybaraClient({ apiKey: process.env.SCRAPYBARA_API_KEY || '' });
  
  console.log(`₍ᐢ•(ܫ)•ᐢ₎ Calling client.get() for instance...`);
  
  let remoteInstance = await client.get(provider_instance_id);
  
  // Auto-resume if paused
  if ((remoteInstance as any)?.status === 'paused') {
    console.log(`₍ᐢ•(ܫ)•ᐢ₎ Instance is paused. Attempting resume before acting...`);
    try {
      const apiKey = process.env.SCRAPYBARA_API_KEY || '';
      const resumeResp = await fetch(`https://api.scrapybara.com/v1/instance/${provider_instance_id}/resume`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
        },
        body: JSON.stringify({ timeout_hours: 1 }),
      });
      if (!resumeResp.ok) {
        const errText = await resumeResp.text();
        throw new Error(`Resume failed: ${resumeResp.status} ${errText}`);
      }
      // Re-fetch instance to get updated status
      remoteInstance = await client.get(provider_instance_id);
      await supabaseAdmin
        .from('remote_instances')
        .update({ status: 'running', updated_at: new Date().toISOString() })
        .eq('provider_instance_id', provider_instance_id);
      console.log(`₍ᐢ•(ܫ)•ᐢ₎ ✅ Instance resumed successfully`);
    } catch (resumeError: any) {
      console.warn(`₍ᐢ•(ܫ)•ᐢ₎ ⚠️ Failed to resume instance: ${resumeError?.message || resumeError}`);
    }
  }
  console.log(`₍ᐢ•(ܫ)•ᐢ₎ ✅ Connected to existing instance: [${provider_instance_id}]`);
  
  return { client, remoteInstance };
}

/**
 * Validate instance status
 */
export function validateInstanceStatus(remoteInstance: any) {
  const instanceStatus = (remoteInstance as any).status;
  console.log(`₍ᐢ•(ܫ)•ᐢ₎ [INSTANCE_STATUS] Scrapybara instance status: ${instanceStatus}`);
  
  if (instanceStatus !== 'running') {
    console.error(`₍ᐢ•(ܫ)•ᐢ₎ [INSTANCE_STATUS] ❌ Instance is not running! Status: ${instanceStatus}`);
    console.error(`₍ᐢ•(ܫ)•ᐢ₎ [INSTANCE_STATUS] This explains why fetch fails - instance is not active`);
    
    return {
      valid: false,
      status: instanceStatus,
      error: `Remote instance is not running. Current status: ${instanceStatus}`
    };
  }
  
  // Verify it's an Ubuntu instance for the tools
  if (!('browser' in remoteInstance)) {
    return {
      valid: false,
      status: instanceStatus,
      error: 'Instance must be Ubuntu type to execute plan'
    };
  }
  
  return {
    valid: true,
    status: instanceStatus,
    error: null
  };
}

/**
 * Verify browser responsiveness
 */
export async function verifyBrowserResponsive(remoteInstance: any) {
  console.log(`₍ᐢ•(ܫ)•ᐢ₎ [BROWSER_CHECK] Verifying browser responsiveness...`);
  try {
    const testScreenshot = await remoteInstance.computer({ action: 'take_screenshot' });
    console.log(`₍ᐢ•(ܫ)•ᐢ₎ [BROWSER_CHECK] Screenshot obtained, checking if browser is active...`);
    
    // Check if screenshot indicates a black screen or inactive browser
    if (testScreenshot && testScreenshot.base64Image) {
      console.log(`₍ᐢ•(ܫ)•ᐢ₎ [BROWSER_CHECK] Browser appears to be running (screenshot: ${testScreenshot.base64Image.length} chars)`);
      
      // CRITICAL: Activate browser window by clicking center of screen
      // This ensures the browser has focus and can receive input
      console.log(`₍ᐢ•(ܫ)•ᐢ₎ [BROWSER_ACTIVATE] Clicking center of screen to activate browser window...`);
      try {
        const activateResult = await remoteInstance.computer({ 
          action: 'click_mouse',
          button: 'left',
          coordinates: [640, 360] // Center of 1280x720 display
        });
        console.log(`₍ᐢ•(ܫ)•ᐢ₎ [BROWSER_ACTIVATE] Activation click result:`, {
          output: activateResult?.output || '(empty)',
          error: activateResult?.error || '(empty)',
          hasScreenshot: !!activateResult?.base64Image,
          hasSystemField: !!activateResult?.system
        });
        
        // CRITICAL: Check system field for errors
        if (activateResult?.system) {
          console.log(`₍ᐢ•(ܫ)•ᐢ₎ [BROWSER_ACTIVATE] System field:`, JSON.stringify(activateResult.system));
          if (typeof activateResult.system === 'object' && activateResult.system !== null) {
            const systemObj = activateResult.system as any;
            if (systemObj.error || systemObj.message) {
              console.error(`🚨 [BROWSER_ACTIVATE] System field indicates issue:`, activateResult.system);
            }
          }
        }
        
        // Wait a moment for the browser to process the click and gain focus
        await new Promise(resolve => setTimeout(resolve, 500));
        console.log(`₍ᐢ•(ܫ)•ᐢ₎ [BROWSER_ACTIVATE] ✅ Browser activation complete`);
      } catch (activateError: any) {
        console.warn(`₍ᐢ•(ܫ)•ᐢ₎ [BROWSER_ACTIVATE] ⚠️ Failed to activate browser: ${activateError.message}`);
      }
      
      // Log the output/error from initial screenshot
      if (testScreenshot.output) {
        console.log(`₍ᐢ•(ܫ)•ᐢ₎ [BROWSER_CHECK] Output: "${testScreenshot.output}"`);
      }
      if (testScreenshot.error && testScreenshot.error.length > 0) {
        console.warn(`₍ᐢ•(ܫ)•ᐢ₎ [BROWSER_CHECK] ⚠️ Error detected: "${testScreenshot.error}"`);
      }
      
      return { responsive: true };
    } else {
      console.warn(`₍ᐢ•(ܫ)•ᐢ₎ [BROWSER_CHECK] ⚠️ No screenshot received - browser may not be running`);
      return { responsive: false, error: 'No screenshot received' };
    }
  } catch (browserCheckError: any) {
    console.error(`₍ᐢ•(ܫ)•ᐢ₎ [BROWSER_CHECK] ❌ Failed to verify browser: ${browserCheckError.message}`);
    console.log(`₍ᐢ•(ܫ)•ᐢ₎ [BROWSER_CHECK] Proceeding anyway - browser may need to be started`);
    return { responsive: false, error: browserCheckError.message };
  }
}

/**
 * Check if this is a subsequent plan execution
 */
export async function checkIfSubsequentPlan(instance_id: string) {
  const { data: previousPlans, error: prevPlansError } = await supabaseAdmin
    .from('instance_plans')
    .select('id, status, created_at')
    .eq('instance_id', instance_id)
    .order('created_at', { ascending: false })
    .limit(5);
  
  const completedPlansCount = previousPlans?.filter(p => p.status === 'completed' || p.status === 'failed').length || 0;
  const isSubsequentPlan = completedPlansCount > 0;
  console.log(`₍ᐢ•(ܫ)•ᐢ₎ [INSTANCE_CONNECTION] This is plan execution #${completedPlansCount + 1} for this instance`);
  
  if (isSubsequentPlan) {
    console.log(`₍ᐢ•(ܫ)•ᐢ₎ [INSTANCE_CONNECTION] ⚠️ Previous plans detected (${completedPlansCount}) - connection may need refresh`);
    console.log(`₍ᐢ•(ܫ)•ᐢ₎ [INSTANCE_CONNECTION] 🧪 This is a subsequent plan - will skip re-authentication to test if that's causing input issues`);
  }
  
  return { isSubsequentPlan, completedPlansCount };
}
