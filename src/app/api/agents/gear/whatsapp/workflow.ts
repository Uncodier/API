'use workflow';

import { runAssistantWorkflow } from '@/app/api/robots/instance/assistant/workflow';
import { sendWhatsAppResponse, sendWhatsAppError, sendWhatsAppTypingIndicator } from './steps';

interface GearAgentWorkflowInput {
  instanceId: string;
  message: string;
  messageSid?: string;
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
      'gear'
    );

    console.log(`[GearAgent] Assistant execution completed. Response length: ${result.assistant_response?.length || 0}`);

    if (result.assistant_response) {
      // Send the response back to WhatsApp via step
      await sendWhatsAppResponse(userPhone, result.assistant_response, siteId);
    } else {
      console.warn(`[GearAgent] No assistant response generated`);
    }

    return {
      success: true,
      assistant_response: result.assistant_response,
      instance_id: instanceId
    };

  } catch (error: any) {
    console.error(`[GearAgent] Workflow failed:`, error);
    
    // Attempt to send error message to user via step
    await sendWhatsAppError(userPhone, siteId);

    throw error;
  }
}
