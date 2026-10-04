import { NextResponse } from 'next/server';
import { CommandFactory } from '@/lib/agentbase';
import { buildCustomerSupportTools } from '@/lib/services/customer-support-tool-catalog';
import { commandService, getCommandDbUuid, waitForCommandCompletion } from './command-runtime';
import { isValidUUID } from './agent-data';
import { corsHeaders } from './cors';
export async function generateSupportReply(input: any) {
const { effectiveUserId, effectiveAgentId, effectiveSiteId, effectiveLeadId, contextMessage, agentUserId, request } = input;
    const command = CommandFactory.createCommand({
      task: 'create message',
      userId: effectiveUserId,
      agentId: effectiveAgentId,
      agentRole: 'Customer Support',
      // Add site_id as a basic property if it exists
      ...(effectiveSiteId ? { site_id: effectiveSiteId } : {}),
      // Add lead_id as a basic property if it exists
      ...(effectiveLeadId ? { lead_id: effectiveLeadId } : {}),
      description: 'Respond helpfully to the customer inquiries about your business. For any complex request, ALWAYS use the skill lookup tool at the beginning to search for relevant skills or procedures to follow BEFORE proceeding.',
      // Set the target as a message with content
      targets: [
        {
          message: {
            content: "message example", // Will be filled by the agent
            is_robot: false, // Set to true if this is a robot/automated interaction that should not be saved to DB
            is_transactional_message: false, // Set to true if this is a transactional/automatic message that should not be saved to DB
            is_erratic: false // Set to true if the message is nonsensical or makes no sense and should not be saved to DB
          }
        },
        {
          conversation: {
            title: "conversation title", // Will be filled by the agent
            is_robot: false, // Set to true if this conversation is with a robot/bot and should not be saved to DB
            is_transactional_message: false, // Set to true if this is a transactional conversation that should not be saved to DB
            is_erratic: false // Set to true if the conversation is nonsensical and should not be saved to DB
          }
        }
      ],
      // Define the tools as specified in the documentation
      tools: buildCustomerSupportTools(effectiveSiteId),
      // Context includes the current message and conversation history
      context: contextMessage,
      // Add supervisors as specified in the documentation
      supervisor: [
        {
          agent_role: 'sales',
          status: 'not_initialized'
        },
        {
          agent_role: 'manager',
          status: 'not_initialized'
        }
      ],
      // Replies and tools share the centrally configured OpenRouter model.
      modelType: 'openrouter',
      reasoningEffort: 'low',
      verbosity: 'low',
      toolsModelType: 'openrouter'
    });
    
    // Submit the command for processing
    const internalCommandId = await commandService.submitCommand(command);
    console.log(`📝 Comando creado con ID interno: ${internalCommandId}`);
    console.log(`[CustomerSupport] Using the configured OpenRouter model for responses and tools`);
    
    // Intentar obtener el UUID de la base de datos inmediatamente después de crear el comando
    let initialDbUuid = await getCommandDbUuid(internalCommandId);
    if (initialDbUuid) {
      console.log(`📌 UUID de base de datos obtenido inicialmente: ${initialDbUuid}`);
    } else {
      console.warn(`⚠️ No se pudo obtener UUID inicialmente, esperando a que el comando se complete...`);
    }
    
    // Validar y reintentar si no se obtuvo un UUID válido
    if (!initialDbUuid || !isValidUUID(initialDbUuid)) {
      console.error(`❌ Failed to retrieve valid database UUID for command ${internalCommandId}`);
      // Additional retry logic
      await new Promise(resolve => setTimeout(resolve, 500)); // Wait 500ms
      const retryUuid = await getCommandDbUuid(internalCommandId);
      if (retryUuid && isValidUUID(retryUuid)) {
        initialDbUuid = retryUuid;
        console.log(`✅ Retry successful: ${initialDbUuid}`);
      }
    }
    
    // Esperar a que el comando se complete utilizando nuestra función
    const { command: executedCommand, dbUuid, completed } = await waitForCommandCompletion(internalCommandId);
    
    // CRITICAL: Verify command completed successfully BEFORE processing results
    // This check must run regardless of UUID validity
    if (!completed || !executedCommand) {
      console.error(`❌ Error en ejecución del comando, completed=${completed}, executedCommand=${!!executedCommand}`);
      return NextResponse.json(
        { 
          success: false, 
          error: { 
            code: 'COMMAND_EXECUTION_FAILED', 
            message: 'The command did not complete successfully in the expected time' 
          },
          debug: {
            agent_id: effectiveAgentId,
            user_id: effectiveUserId,
            agent_user_id: agentUserId,
            site_id: effectiveSiteId,
            command_id: internalCommandId
          }
        },
        { 
          status: 500,
          headers: corsHeaders(request)
        }
      );
    }
    
    // Usar el UUID obtenido inicialmente si no tenemos uno válido después de la ejecución
    let effectiveDbUuid: string | null | undefined = (dbUuid && isValidUUID(dbUuid)) ? dbUuid : initialDbUuid;
    
    // Verificar que tenemos un UUID de base de datos válido
    if (!effectiveDbUuid || !isValidUUID(effectiveDbUuid)) {
      console.error(`❌ No se pudo obtener un UUID válido de la base de datos para el comando ${internalCommandId}`);
      console.error(`❌ effectiveDbUuid recibido: ${effectiveDbUuid}`);
      console.error(`❌ dbUuid from completion: ${dbUuid}`);
      console.error(`❌ initialDbUuid: ${initialDbUuid}`);
      
      // Set to undefined to prevent passing invalid UUID to saveMessages
      // This will cause saveMessages to skip adding command_id, which is safer than passing invalid ID
      const invalidUuid = effectiveDbUuid;
      effectiveDbUuid = undefined;
      console.log(`⚠️ Setting effectiveDbUuid to undefined to prevent foreign key errors. Original value was: ${invalidUuid}`);
    }
    

return { executedCommand, effectiveDbUuid };
}
