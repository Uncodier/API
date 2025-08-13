/**
 * StreamingResponseProcessor - Maneja el procesamiento de respuestas streaming del LLM
 */
import { DbCommand, CommandExecutionResult } from '../../models/types';
import { CommandCache } from '../../services/command/CommandCache';

export class StreamingResponseProcessor {
  /**
   * Procesa una respuesta streaming del LLM
   * @param stream El stream de respuesta del LLM
   * @param command El comando original
   * @param modelInfo Información del modelo usado
   * @param fillTargetWithContent Función para rellenar targets con contenido
   * @returns El resultado del comando procesado
   */
  static async processStreamingResponse(
    stream: any, 
    command: DbCommand, 
    modelInfo: any,
    fillTargetWithContent: (target: any, content: any) => any
  ): Promise<CommandExecutionResult> {
    let fullContent = '';
    let tokenUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
    
    try {
      console.log(`[StreamingResponseProcessor] Iniciando procesamiento de stream...`);
      
      // Iterar sobre el stream y acumular contenido
      for await (const chunk of stream) {
        if (chunk.choices?.[0]?.delta?.content) {
          const deltaContent = chunk.choices[0].delta.content;
          fullContent += deltaContent;
          
          // Log progress to show streaming is working
          if (fullContent.length % 100 === 0) {
            console.log(`[StreamingResponseProcessor] Stream progress: ${fullContent.length} characters received...`);
          }
        }
        
        // Extract usage if available in final chunk
        if (chunk.usage) {
          tokenUsage = {
            prompt_tokens: chunk.usage.prompt_tokens || 0,
            completion_tokens: chunk.usage.completion_tokens || 0,
            total_tokens: chunk.usage.total_tokens || (chunk.usage.prompt_tokens || 0) + (chunk.usage.completion_tokens || 0)
          };
          console.log(`[StreamingResponseProcessor] Token usage from stream: ${JSON.stringify(tokenUsage)}`);
        }
      }
      
      console.log(`[StreamingResponseProcessor] Stream completed. Total content length: ${fullContent.length}`);
      console.log(`[StreamingResponseProcessor] Final content preview: ${fullContent.substring(0, 200)}...`);
      
      // Process the accumulated content same as non-streaming response
      let results = StreamingResponseProcessor.processStreamContent(fullContent, command, fillTargetWithContent);
      
      // Crear una copia limpia del comando actualizado con los resultados del stream
      const updatedCommand = {
        ...command,
        results: results,
        updated_at: new Date().toISOString()
      };
      
      // Guardar en caché para futuras consultas
      CommandCache.cacheCommand(command.id, {
        ...command,
        results: results
      });
      
      return {
        status: 'completed',
        results,
        updatedCommand: updatedCommand,
        inputTokens: tokenUsage.prompt_tokens,
        outputTokens: tokenUsage.completion_tokens
      };
      
    } catch (error) {
      console.error(`[StreamingResponseProcessor] Error processing streaming response:`, error);
      
      // Crear un comando actualizado incluso en caso de error
      const errorResults = [{
        error: `Stream processing failed: ${error instanceof Error ? error.message : 'Unknown error'}`
      }];
      
      const updatedCommand = {
        ...command,
        results: errorResults,
        updated_at: new Date().toISOString()
      };
      
      return {
        status: 'failed',
        results: errorResults,
        updatedCommand: updatedCommand,
        inputTokens: tokenUsage.prompt_tokens,
        outputTokens: tokenUsage.completion_tokens,
        error: `Stream processing failed: ${error instanceof Error ? error.message : 'Unknown error'}`
      };
    }
  }

  /**
   * Procesa el contenido acumulado del stream
   */
  private static processStreamContent(
    fullContent: string, 
    command: DbCommand, 
    fillTargetWithContent: (target: any, content: any) => any
  ): any[] {
    let results;
    
    try {
      if (typeof fullContent === 'string') {
        if (fullContent.trim().startsWith('[') && fullContent.trim().endsWith(']')) {
          try {
            results = JSON.parse(fullContent);
            console.log(`[StreamingResponseProcessor] Stream response parsed as JSON array: ${results.length} elements`);
          } catch (e) {
            console.log(`[StreamingResponseProcessor] Error parsing stream array JSON, preserving target structure`);
            results = (command.targets || []).map((target, index) => {
              const targetCopy = JSON.parse(JSON.stringify(target));
              return fillTargetWithContent(targetCopy, fullContent);
            });
          }
        } else {
          try {
            const parsedContent = JSON.parse(fullContent);
            if (Array.isArray(parsedContent)) {
              results = parsedContent;
              console.log(`[StreamingResponseProcessor] Stream response parsed as valid JSON array: ${results.length} elements`);
            } else if (typeof parsedContent === 'object' && parsedContent !== null) {
              results = [parsedContent];
              console.log(`[StreamingResponseProcessor] Stream response parsed as valid JSON object and wrapped in array`);
            } else {
              results = (command.targets || []).map((target, index) => {
                const targetCopy = JSON.parse(JSON.stringify(target));
                return fillTargetWithContent(targetCopy, parsedContent);
              });
            }
          } catch (parseError) {
            console.log(`[StreamingResponseProcessor] Error parsing stream JSON, using as raw text in target structure`);
            results = (command.targets || []).map((target, index) => {
              const targetCopy = JSON.parse(JSON.stringify(target));
              return fillTargetWithContent(targetCopy, fullContent);
            });
          }
        }
      } else {
        console.log(`[StreamingResponseProcessor] Stream response is not a string, using target structure`);
        results = (command.targets || []).map((target, index) => {
          const targetCopy = JSON.parse(JSON.stringify(target));
          return fillTargetWithContent(targetCopy, fullContent);
        });
      }
    } catch (processingError) {
      console.error(`[StreamingResponseProcessor] Error processing stream content:`, processingError);
      results = [{
        error: `Error processing streamed response: ${processingError instanceof Error ? processingError.message : 'Unknown error'}`
      }];
    }
    
    return results;
  }
}
