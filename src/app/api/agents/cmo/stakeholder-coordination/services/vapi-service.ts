import { VapiClient } from "@vapi-ai/server-sdk";

/**
 * Servicio para interactuar con Vapi (API de llamadas telefónicas)
 */
export class VapiService {
  private static vapiClient: VapiClient;
  
  /**
   * Inicializa el cliente de Vapi
   * @returns Cliente inicializado
   */
  private static getClient(): VapiClient {
    if (!VapiService.vapiClient) {
      VapiService.vapiClient = new VapiClient({
        token: process.env.VAPI_API_TOKEN || "YOUR_TOKEN"
      });
    }
    return VapiService.vapiClient;
  }
  
  /**
   * Inicia una llamada telefónica con un asistente
   * @param phoneNumber Número de teléfono al que se llamará
   * @param meetingDetails Detalles de la reunión
   * @param systemPrompt Instrucciones del sistema para el asistente
   * @param agentBackground Contexto del agente (opcional)
   * @returns Información sobre la llamada iniciada
   */
  public static async initiateCall(
    phoneNumber: string,
    meetingDetails: { title: string; objective: string },
    systemPrompt: string,
    agentBackground?: string
  ): Promise<{ id: string; status: string; phone_number: string }> {
    try {
      console.log(`📞 Iniciando llamada a ${phoneNumber} usando Vapi...`);
      
      // Determinar el contenido del prompt del sistema
      let systemPromptContent;
      if (agentBackground) {
        console.log(`🔍 Usando agent_background para Vapi (${agentBackground.length} caracteres)`);
        systemPromptContent = agentBackground;
      } else {
        systemPromptContent = systemPrompt;
        console.log(`⚠️ No se encontró agent_background, usando fallback para Vapi (${systemPromptContent.length} caracteres)`);
      }
      
      // Mensaje adicional específico para Vapi con las instrucciones sobre formatos esperados
      const vapiSpecificInstructions = `EXPECTED OUTPUTS:
The following outputs are required as part of your communication for this CEO-level stakeholder meeting:

1. SUMMARY MESSAGE: Provide a clear, executive-level summary of the key discussion points from the meeting.
   Format: "EXECUTIVE SUMMARY: [concise overview of what was discussed and decided]"

2. ACTION ITEMS: List specific tasks that need to be completed with assigned owners across different stakeholder departments.
   Format: "ACTION ITEMS:
   - [Task description] - Assigned to: [name/department]
   - [Task description] - Assigned to: [name/department]"

3. DO'S AND DON'TS: Provide strategic guidance on what approaches to pursue and avoid that the CEO and stakeholders can reference.
   Format: "STRATEGIC GUIDANCE:
   DO:
   - [strategic approach to take]
   - [strategic approach to take]
   DON'T:
   - [approach to avoid]
   - [approach to avoid]"

IMPORTANT: You MUST include these three message types in your communication to ensure the CEO and all stakeholders have clear direction for effective follow-through on all meeting discussions.`;

      // Combinar el contenido del system prompt con las instrucciones específicas para Vapi
      const completeVapiPrompt = `${systemPromptContent}\n\n${vapiSpecificInstructions}`;
      
      const client = VapiService.getClient();
      
      // Crear un asistente en Vapi para esta llamada específica
      const assistant = await client.assistants.create({
        name: "CMO Stakeholder Coordinator",
        model: {
          provider: "openai",
          model: "gpt-4",
          temperature: 0.7,
          messages: [
            {
              role: "system",
              content: completeVapiPrompt
            }
          ]
        } as any,
        voice: {
          provider: "11labs",
          voiceId: "alloy"
        },
        firstMessage: meetingDetails.title ? 
          `Hola, esto es una llamada para coordinar la reunión "${meetingDetails.title}". ${meetingDetails.objective ? `El objetivo es ${meetingDetails.objective}.` : ''}` : 
          "Hola, esto es una llamada para coordinar una reunión de stakeholders de marketing."
      });
      
      console.log(`✅ Asistente Vapi creado con ID: ${assistant.id}`);
      
      // Crear llamada en Vapi con aserción de tipo para evitar todos los errores de tipos
      const callResponse = await client.calls.create({
        phoneNumber: {
          to: phoneNumber
        } as any,
        assistant: {
          id: assistant.id
        } as any,
        recordingEnabled: true
      } as any);
      
      console.log(`📞 Llamada Vapi iniciada:`, callResponse);
      
      // Extraer detalles de la llamada para la respuesta
      return {
        id: (callResponse as any).id || `call-${Date.now()}`,
        status: (callResponse as any).status || "pending",
        phone_number: phoneNumber
      };
    } catch (error) {
      console.error('Error al crear llamada Vapi:', error);
      return {
        id: `error-${Date.now()}`,
        status: "failed",
        phone_number: phoneNumber
      };
    }
  }
} 