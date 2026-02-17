/**
 * Tools Setup Service
 * Handles creation, validation, and retry logic for Scrapybara tools
 */

import { bashTool, computerTool, editTool } from 'scrapybara/tools';
import { webSearchToolScrapybara } from '@/app/api/agents/tools/webSearch/assistantProtocol';
import { ScrapybaraClient } from 'scrapybara';

/**
 * Helper function to add retry logic and detailed logging to Scrapybara tools
 */
function createToolWithRetry(originalTool: any, toolName: string, maxRetries: number = 2) {
  return {
    ...originalTool,
    execute: async (args: any) => {
      let lastError: any = null;
      let attempt = 0;
      
      while (attempt <= maxRetries) {
        attempt++;
        const attemptPrefix = attempt > 1 ? `[RETRY ${attempt - 1}/${maxRetries}] ` : '';
        
        try {
          console.log(`₍ᐢ•(ܫ)•ᐢ₎ ${attemptPrefix}[${toolName.toUpperCase()}] Executing with args:`, JSON.stringify(args).substring(0, 200));
          
          const startTime = Date.now();
          console.log(`₍ᐢ•(ܫ)•ᐢ₎ ${attemptPrefix}[${toolName.toUpperCase()}] Calling originalTool.execute()...`);
          const result = await originalTool.execute(args);
          const duration = Date.now() - startTime;
          
          console.log(`₍ᐢ•(ܫ)•ᐢ₎ ${attemptPrefix}[${toolName.toUpperCase()}] ✅ Success in ${duration}ms`);
          console.log(`₍ᐢ•(ܫ)•ᐢ₎ ${attemptPrefix}[${toolName.toUpperCase()}] Result received from Scrapybara SDK`);
          
          // Validate result for computer tool actions
          if (toolName === 'computer' && args.action !== 'take_screenshot') {
            // Check if result contains error indicators
            if (typeof result === 'string' && (
              result.includes('error') || 
              result.includes('failed') || 
              result.includes('timeout')
            )) {
              console.warn(`₍ᐢ•(ܫ)•ᐢ₎ ${attemptPrefix}[${toolName.toUpperCase()}] ⚠️ Result contains error indicators: ${result.substring(0, 100)}`);
              throw new Error(`Action may have failed: ${result.substring(0, 200)}`);
            }
            
            // For click/type actions, verify we got a valid response
            if (!result || (typeof result === 'object' && Object.keys(result).length === 0)) {
              console.warn(`₍ᐢ•(ܫ)•ᐢ₎ ${attemptPrefix}[${toolName.toUpperCase()}] ⚠️ Empty or invalid result received`);
              throw new Error('Empty result from tool execution');
            }
          }
          
          // Log result details (truncated for screenshots)
          if (typeof result === 'string' && result.length > 1000) {
            console.log(`₍ᐢ•(ܫ)•ᐢ₎ ${attemptPrefix}[${toolName.toUpperCase()}] Result: [Large data - ${result.length} chars]`);
          } else if (typeof result === 'object' && (result.base64Image || result.base64_image)) {
            const imageLength = result.base64Image?.length || result.base64_image?.length || 0;
            console.log(`₍ᐢ•(ܫ)•ᐢ₎ ${attemptPrefix}[${toolName.toUpperCase()}] Result: [Screenshot - ${imageLength} chars]`);
          } else {
            console.log(`₍ᐢ•(ܫ)•ᐢ₎ ${attemptPrefix}[${toolName.toUpperCase()}] Result:`, JSON.stringify(result).substring(0, 200));
          }
          
          return result;
        } catch (error: any) {
          lastError = error;
          const errorMessage = error.message || String(error);
          console.error(`₍ᐢ•(ܫ)•ᐢ₎ ${attemptPrefix}[${toolName.toUpperCase()}] ❌ Error: ${errorMessage.substring(0, 200)}`);
          
          // CRITICAL: Log full error for fetch failures
          if (errorMessage.includes('fetch failed') || errorMessage.includes('ECONNREFUSED')) {
            console.error(`₍ᐢ•(ܫ)•ᐢ₎ ${attemptPrefix}[${toolName.toUpperCase()}] Full fetch error:`, {
              message: error.message,
              code: error.code,
              cause: error.cause?.message || error.cause,
              stack: error.stack?.substring(0, 300)
            });
            console.error(`₍ᐢ•(ܫ)•ᐢ₎ ${attemptPrefix}[${toolName.toUpperCase()}] This indicates network/connectivity issue with Scrapybara API`);
            console.error(`₍ᐢ•(ܫ)•ᐢ₎ ${attemptPrefix}[${toolName.toUpperCase()}] Instance may be stopped, or API endpoint unreachable`);
          }
          
          // Don't retry on certain errors
          const shouldNotRetry = 
            errorMessage.includes('authentication required') ||
            errorMessage.includes('not found') ||
            errorMessage.includes('invalid argument') ||
            attempt > maxRetries;
          
          if (shouldNotRetry) {
            console.error(`₍ᐢ•(ܫ)•ᐢ₎ [${toolName.toUpperCase()}] Not retrying due to: ${shouldNotRetry ? 'non-retryable error or max retries reached' : ''}`);
            throw error;
          }
          
          // Wait before retry (exponential backoff)
          const waitTime = Math.min(1000 * Math.pow(2, attempt - 1), 5000);
          console.log(`₍ᐢ•(ܫ)•ᐢ₎ [${toolName.toUpperCase()}] Waiting ${waitTime}ms before retry...`);
          await new Promise(resolve => setTimeout(resolve, waitTime));
        }
      }
      
      // If we get here, all retries failed
      console.error(`₍ᐢ•(ܫ)•ᐢ₎ [${toolName.toUpperCase()}] ❌ All ${maxRetries + 1} attempts failed`);
      throw lastError;
    }
  };
}

/**
 * Setup tools for an instance
 */
export function setupTools(ubuntuInstance: any) {
  console.log(`₍ᐢ•(ܫ)•ᐢ₎ [TOOLS_SETUP] Creating tools for instance`);
  console.log(`₍ᐢ•(ܫ)•ᐢ₎ [TOOLS_SETUP] Instance object keys:`, Object.keys(ubuntuInstance).join(', '));
  console.log(`₍ᐢ•(ܫ)•ᐢ₎ [TOOLS_SETUP] Instance status: ${(ubuntuInstance as any).status || 'unknown'}`);
  
  const tools = [
    createToolWithRetry(bashTool(ubuntuInstance), 'bash', 2),
    createToolWithRetry(computerTool(ubuntuInstance), 'computer', 2),
    createToolWithRetry(editTool(ubuntuInstance), 'edit', 1),
    createToolWithRetry(webSearchToolScrapybara(ubuntuInstance), 'webSearch', 2),
  ] as any;
  
  console.log(`₍ᐢ•(ܫ)•ᐢ₎ [TOOLS] Using Scrapybara SDK tools with retry logic:`);
  console.log(`  - bashTool: Execute bash commands (max 2 retries)`);
  console.log(`  - computerTool: Mouse, keyboard, screenshot actions (max 2 retries)`);
  console.log(`  - editTool: File editing operations (max 1 retry)`);
  console.log(`  - webSearchTool: Perform web searches (max 2 retries)`);
  
  return tools;
}

/**
 * Validate tools by testing them
 */
export async function validateTools(
  tools: any[], 
  client: ScrapybaraClient,
  provider_instance_id: string
): Promise<{ valid: boolean; tools: any[] }> {
  console.log(`₍ᐢ•(ܫ)•ᐢ₎ [TOOLS_TEST] Testing computerTool immediately after creation...`);
  let toolsAreValid = false;
  let toolTestAttempts = 0;
  const maxToolTestAttempts = 2;
  let currentTools = tools;
  
  while (!toolsAreValid && toolTestAttempts < maxToolTestAttempts) {
    toolTestAttempts++;
    try {
      const testResult = await currentTools[1].execute({ action: 'take_screenshot' });
      // Scrapybara SDK uses camelCase: base64Image (not base64_image)
      const testScreenshotLength = testResult?.base64Image?.length || testResult?.base64_image?.length || 0;
      console.log(`₍ᐢ•(ܫ)•ᐢ₎ [TOOLS_TEST] Attempt ${toolTestAttempts}: Screenshot length: ${testScreenshotLength}`);
      
      if (testScreenshotLength > 0) {
        console.log(`₍ᐢ•(ܫ)•ᐢ₎ [TOOLS_TEST] ✅ computerTool works! Screenshot length: ${testScreenshotLength}`);
        toolsAreValid = true;
      } else {
        console.error(`₍ᐢ•(ܫ)•ᐢ₎ [TOOLS_TEST] ❌ Attempt ${toolTestAttempts}: computerTool returned empty screenshot!`);
        
        // If this is not the last attempt, try recreating the tools
        if (toolTestAttempts < maxToolTestAttempts) {
          console.log(`₍ᐢ•(ܫ)•ᐢ₎ [TOOLS_TEST] 🔄 Attempting to reconnect to instance and recreate tools...`);
          await new Promise(resolve => setTimeout(resolve, 2000)); // Wait 2s before reconnecting
          
          // Reconnect to instance
          const freshInstance = await client.get(provider_instance_id);
          console.log(`₍ᐢ•(ܫ)•ᐢ₎ [TOOLS_TEST] Reconnected to instance: ${provider_instance_id}`);
          
          // Recreate tools with fresh instance
          const freshUbuntuInstance = freshInstance as any;
          currentTools = setupTools(freshUbuntuInstance);
          console.log(`₍ᐢ•(ܫ)•ᐢ₎ [TOOLS_TEST] Tools recreated with fresh instance`);
        }
      }
    } catch (toolTestError: any) {
      console.error(`₍ᐢ•(ܫ)•ᐢ₎ [TOOLS_TEST] ❌ Attempt ${toolTestAttempts}: computerTool test FAILED: ${toolTestError.message}`);
      
      // If this is not the last attempt, try recreating
      if (toolTestAttempts < maxToolTestAttempts) {
        console.log(`₍ᐢ•(ܫ)•ᐢ₎ [TOOLS_TEST] 🔄 Attempting to reconnect and recreate tools after error...`);
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        try {
          const freshInstance = await client.get(provider_instance_id);
          const freshUbuntuInstance = freshInstance as any;
          currentTools = setupTools(freshUbuntuInstance);
          console.log(`₍ᐢ•(ܫ)•ᐢ₎ [TOOLS_TEST] Tools recreated after error`);
        } catch (reconnectError: any) {
          console.error(`₍ᐢ•(ܫ)•ᐢ₎ [TOOLS_TEST] ❌ Failed to reconnect: ${reconnectError.message}`);
        }
      }
    }
  }
  
  if (!toolsAreValid) {
    console.error(`₍ᐢ•(ܫ)•ᐢ₎ [TOOLS_TEST] ❌❌❌ CRITICAL: Tools are NOT working after ${maxToolTestAttempts} attempts!`);
    console.error(`₍ᐢ•(ܫ)•ᐢ₎ [TOOLS_TEST] This indicates a serious connection issue with the instance!`);
    return { valid: false, tools: currentTools };
  }
  
  console.log(`₍ᐢ•(ܫ)•ᐢ₎ [TOOLS_TEST] ✅✅✅ Tools validated successfully and ready to use`);
  return { valid: true, tools: currentTools };
}
