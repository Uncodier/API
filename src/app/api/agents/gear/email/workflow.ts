'use workflow';

import { runAssistantWorkflow } from '@/app/api/robots/instance/assistant/workflow';
import { sendEmailResponse, sendEmailError } from './steps';

interface GearEmailWorkflowInput {
  instanceId: string;
  message: string;
  messageSid?: string;
  siteId: string;
  userId: string;
  userEmail: string;
  customTools?: any[];
  useSdkTools?: boolean;
  systemPrompt?: string;
}

export async function runGearEmailWorkflow({
  instanceId,
  message,
  messageSid,
  siteId,
  userId,
  userEmail,
  customTools = [],
  useSdkTools = false,
  systemPrompt
}: GearEmailWorkflowInput) {
  'use workflow';

  console.log(`[GearAgent] Starting email workflow for user ${userId} (${userEmail}) on instance ${instanceId}`);

  try {
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
      userEmail // We pass userEmail instead of userPhone here
    );

    console.log(`[GearAgent] Assistant execution completed. Response length: ${result.assistant_response?.length || 0}`);

    if (result.assistant_response) {
      // Send the response back to Email via step
      await sendEmailResponse(userEmail, result.assistant_response, siteId);
    } else {
      console.warn(`[GearAgent] No assistant response generated`);
    }

    return {
      success: true,
      assistant_response: result.assistant_response,
      instance_id: instanceId
    };

  } catch (error: any) {
    console.error(`[GearAgent] Email Workflow failed:`, error);
    
    // Attempt to send error message to user via step
    await sendEmailError(userEmail, siteId);

    throw error;
  }
}

export async function runUnregisteredGearEmailWorkflow({
  message,
  messageSid,
  siteId,
  userEmail,
  businessAccountId,
  systemPrompt,
  userId,
  profileName
}: {
  message: string;
  messageSid?: string;
  siteId: string;
  userEmail: string;
  businessAccountId?: string;
  systemPrompt: string;
  userId?: string | null;
  profileName?: string;
}) {
  'use workflow';
  
  const { processUnregisteredUserEmailStep } = await import('./steps');

  console.log(`[GearAgent] Starting unregistered/lobby email workflow for ${userEmail}`);

  try {
    // Step runs the assistant locally without creating a remote_instance
    const assistantResponse = await processUnregisteredUserEmailStep(
      userEmail,
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
      // Send the response back via step
      await sendEmailResponse(userEmail, assistantResponse, siteId);
    } else {
      console.warn(`[GearAgent] No assistant response generated for unregistered user`);
    }

    return {
      success: true,
      assistant_response: assistantResponse
    };
  } catch (error: any) {
    console.error(`[GearAgent] Unregistered email workflow failed:`, error);
    await sendEmailError(userEmail, siteId);
    throw error;
  }
}