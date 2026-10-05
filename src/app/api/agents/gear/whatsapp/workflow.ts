'use workflow';

import { runAssistantWorkflow } from '@/app/api/robots/instance/assistant/workflow';
import { sendWhatsAppResponse, sendWhatsAppTypingIndicator } from './steps';

interface GearAgentWorkflowInput {
  instanceId: string;
  message: string;
  messageSid?: string;
  /** Server-persisted action ID; optional for workflows queued before this handoff existed. */
  userMessageLogId?: string;
  siteId: string;
  userId: string;
  userPhone: string;
  customTools?: any[];
  useSdkTools?: boolean;
  systemPrompt?: string;
}

export async function runGearAgentWorkflow({
  instanceId,
  message,
  messageSid,
  userMessageLogId,
  siteId,
  userId,
  userPhone,
  customTools = [],
  useSdkTools = false,
  systemPrompt
}: GearAgentWorkflowInput) {
  'use workflow';

  console.log(`[GearAgent] Starting workflow for user ${userId} (${userPhone}) on instance ${instanceId}`);

  try {
    // Si tenemos el messageSid, enviamos el estado de "escribiendo"
    if (messageSid) {
      await sendWhatsAppTypingIndicator(messageSid, siteId);
    }
    
    // Note: We don't pass gearTools directly as customTools because workflows cannot serialize functions.
    // Instead, we pass 'gear' as the agentType to runAssistantWorkflow.
    
    // Execute the assistant workflow
    const result = await runAssistantWorkflow(
      instanceId,
      message,
      siteId,
      userId,
      customTools,
      useSdkTools,
      systemPrompt,
      'gear',
      userPhone,
      undefined,
      undefined,
      undefined,
      undefined,
      // Never rediscover a webhook action by text: a repeated message may match
      // an older completed action instead of the one admitted for this workflow.
      userMessageLogId ? { userMessageLogId } : undefined
    );

    console.log(`[GearAgent] Assistant execution completed. Response length: ${result.assistant_response?.length || 0}`);

    const executionStatus = 'execution_status' in result ? result.execution_status : undefined;
    const safetyStop = result.success === false || [
      'paused', 'stopped', 'cancelled', 'superseded', 'already_completed', 'continuing', 'exhausted',
    ].includes(executionStatus ?? '');
    if (safetyStop) {
      // Recovery diagnostics remain in the result, never as abandoned-worker replies.
      console.warn('[GearAgent] Suppressed unsuccessful or inactive execution reply');
    } else if (result.assistant_response) {
      // The send step rechecks the persisted action after assistant completion.
      const sent = await sendWhatsAppResponse(userPhone, result.assistant_response, siteId, undefined,
        userMessageLogId ? { instanceId, siteId, userId, userMessageLogId } : undefined);
      if (!sent) console.warn('[GearAgent] Reply was suppressed or could not be delivered; no automatic resend');
    } else {
      console.warn(`[GearAgent] No assistant response generated`);
    }

    return {
      success: result.success !== false,
      ...('execution_status' in result ? { execution_status: result.execution_status } : {}),
      assistant_response: result.assistant_response,
      instance_id: instanceId
    };

  } catch (error: any) {
    console.error(`[GearAgent] Workflow failed:`, error);
    
    // Do not add another message after an internal failure or a partial send.
    throw error;
  }
}

export async function runUnregisteredGearAgentWorkflow({
  message,
  messageSid,
  siteId,
  userPhone,
  businessAccountId,
  systemPrompt,
  userId,
  profileName
}: {
  message: string;
  messageSid?: string;
  siteId: string;
  userPhone: string;
  businessAccountId: string;
  systemPrompt: string;
  userId?: string | null;
  profileName?: string;
}) {
  'use workflow';
  
  // We need to import the step locally or it's already at top of file? No we'll import it at the top
  const { processUnregisteredUserStep } = await import('./steps');

  console.log(`[GearAgent] Starting unregistered/lobby workflow for ${userPhone}`);

  try {
    if (messageSid) {
      await sendWhatsAppTypingIndicator(messageSid, siteId);
    }

    // Step runs the assistant locally without creating a remote_instance
    const assistantResponse = await processUnregisteredUserStep(
      userPhone,
      message,
      businessAccountId,
      messageSid,
      siteId,
      systemPrompt,
      userId,
      profileName
    );

    if (assistantResponse) {
      console.log(`[GearAgent] Assisant execution returned: `, { 
        hasResponse: !!assistantResponse,
        responseLength: assistantResponse?.length
      });
      // Send the response back to WhatsApp via step
      await sendWhatsAppResponse(userPhone, assistantResponse, siteId);
    } else {
      console.warn(`[GearAgent] No assistant response generated for unregistered user`);
    }

    return {
      success: true,
      assistant_response: assistantResponse
    };
  } catch (error: any) {
    console.error(`[GearAgent] Unregistered workflow failed:`, error);
    throw error;
  }
}
