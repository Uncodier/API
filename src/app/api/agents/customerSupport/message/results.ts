
export function extractSupportResults(executedCommand: any) {
    // Extraer la respuesta del asistente
    let assistantMessage = "No response generated";
    let conversationTitle = null;
    
    // Obtener resultados si existen
    if (executedCommand.results && Array.isArray(executedCommand.results)) {
      // Extraer el título de la conversación de los resultados
      const conversationResults = executedCommand.results.find((r: any) => 
        r.conversation && r.conversation.title
      );
      
      if (conversationResults) {
        conversationTitle = conversationResults.conversation.title;
        console.log(`🏷️ Título de conversación encontrado: "${conversationTitle}"`);
      } else {
        // Búsqueda alternativa del título en otras estructuras posibles
        const altTitleResults = executedCommand.results.find((r: any) => 
          (r.content && r.content.conversation && r.content.conversation.title) ||
          (r.type === 'conversation' && r.content && r.content.title)
        );
        
        if (altTitleResults) {
          if (altTitleResults.content && altTitleResults.content.conversation) {
            conversationTitle = altTitleResults.content.conversation.title;
          } else if (altTitleResults.content && altTitleResults.content.title) {
            conversationTitle = altTitleResults.content.title;
          }
          console.log(`🏷️ Título de conversación encontrado (formato alternativo): "${conversationTitle}"`);
        }
      }
      
      
      // EXTRACCIÓN DEL MENSAJE PRINCIPAL - Lógica robusta
      console.log(`🔍 Buscando mensaje del asistente en los resultados...`);
      
      // Prioridad 1: Buscar objetos con property message directamente
      const messageObject = executedCommand.results.find((r: any) => r && r.message && r.message.content);
      if (messageObject) {
        assistantMessage = messageObject.message.content;
        console.log(`✅ Mensaje extraído de objeto con property message directa: ${assistantMessage.substring(0, 50)}...`);
      } 
      // Prioridad 2: Buscar resultados con type 'message' o 'text'
      else {
        const typeResults = executedCommand.results.filter((r: any) => 
          r && (r.type === 'message' || r.type === 'text')
        );
        
        if (typeResults.length > 0) {
          const firstTypeResult = typeResults[0];
          
          if (typeof firstTypeResult.content === 'string') {
            assistantMessage = firstTypeResult.content;
          } 
          else if (firstTypeResult.content && firstTypeResult.content.message && firstTypeResult.content.message.content) {
            assistantMessage = firstTypeResult.content.message.content;
          } 
          else if (firstTypeResult.content && typeof firstTypeResult.content.content === 'string') {
            assistantMessage = firstTypeResult.content.content;
          }
          
          console.log(`✅ Mensaje extraído de resultado con type=${firstTypeResult.type}: ${assistantMessage.substring(0, 50)}...`);
        }
        
        // Prioridad 3: Cualquier objeto con propiedad content
        if (assistantMessage === "No response generated") {
          const contentObject = executedCommand.results.find((r: any) => 
            r && r.content !== undefined && (
              typeof r.content === 'string' || 
              (typeof r.content === 'object' && (r.content.content || r.content.message))
            )
          );
          
          if (contentObject) {
            if (typeof contentObject.content === 'string') {
              assistantMessage = contentObject.content;
            } 
            else if (contentObject.content.message && contentObject.content.message.content) {
              assistantMessage = contentObject.content.message.content;
            } 
            else if (contentObject.content.content) {
              assistantMessage = typeof contentObject.content.content === 'string' 
                ? contentObject.content.content 
                : JSON.stringify(contentObject.content.content);
            }
            
            console.log(`✅ Mensaje extraído de objeto con property content: ${assistantMessage.substring(0, 50)}...`);
          }
          
          // Prioridad 4: Usar el primer resultado disponible
          else if (executedCommand.results.length > 0) {
            const firstResult = executedCommand.results[0];
            
            if (typeof firstResult === 'string') {
              assistantMessage = firstResult;
              console.log(`⚠️ Usando fallback para string directo: ${assistantMessage.substring(0, 50)}...`);
            } 
            else if (typeof firstResult === 'object') {
              // Intentar extraer cualquier contenido que parezca texto
              const extractedContent = 
                firstResult.content || 
                firstResult.message?.content || 
                firstResult.text || 
                JSON.stringify(firstResult);
                
              assistantMessage = typeof extractedContent === 'string' 
                ? extractedContent 
                : JSON.stringify(extractedContent);
                
              console.log(`⚠️ Usando fallback para objeto genérico: ${assistantMessage.substring(0, 50)}...`);
            }
          } else {
            console.log(`❌ No se pudo extraer mensaje - no hay resultados o estructura no reconocida`);
            console.log(`📋 Estructura completa de results:`, JSON.stringify(executedCommand.results, null, 2));
          }
        }
      }
    }
    
    console.log(`💬 Mensaje del asistente: ${assistantMessage.substring(0, 50)}...`);
    
    // Extraer flags is_robot, is_transactional_message e is_erratic de los resultados
    let isRobot: boolean | undefined = undefined;
    let isTransactionalMessage: boolean | undefined = undefined;
    let isErratic: boolean | undefined = undefined;
    
    if (executedCommand.results && Array.isArray(executedCommand.results)) {
      // Buscar flags en message target
      const messageResult = executedCommand.results.find((r: any) => 
        r.message && typeof r.message === 'object'
      );
      if (messageResult && messageResult.message) {
        if (typeof messageResult.message.is_robot === 'boolean') {
          isRobot = messageResult.message.is_robot;
          console.log(`🤖 Flag is_robot encontrado en message: ${isRobot}`);
        }
        if (typeof messageResult.message.is_transactional_message === 'boolean') {
          isTransactionalMessage = messageResult.message.is_transactional_message;
          console.log(`📧 Flag is_transactional_message encontrado en message: ${isTransactionalMessage}`);
        }
        if (typeof messageResult.message.is_erratic === 'boolean') {
          isErratic = messageResult.message.is_erratic;
          console.log(`⚠️ Flag is_erratic encontrado en message: ${isErratic}`);
        }
      }
      
      // Buscar flags en conversation target
      const conversationResult = executedCommand.results.find((r: any) => 
        r.conversation && typeof r.conversation === 'object'
      );
      if (conversationResult && conversationResult.conversation) {
        if (typeof conversationResult.conversation.is_robot === 'boolean') {
          isRobot = conversationResult.conversation.is_robot;
          console.log(`🤖 Flag is_robot encontrado en conversation: ${isRobot}`);
        }
        if (typeof conversationResult.conversation.is_transactional_message === 'boolean') {
          isTransactionalMessage = conversationResult.conversation.is_transactional_message;
          console.log(`📧 Flag is_transactional_message encontrado en conversation: ${isTransactionalMessage}`);
        }
        if (typeof conversationResult.conversation.is_erratic === 'boolean') {
          isErratic = conversationResult.conversation.is_erratic;
          console.log(`⚠️ Flag is_erratic encontrado en conversation: ${isErratic}`);
        }
      }
    }
    

return { assistantMessage, conversationTitle, isRobot, isTransactionalMessage, isErratic };
}
