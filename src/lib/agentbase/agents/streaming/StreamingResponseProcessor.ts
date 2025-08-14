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
    
    // Timeout específico para el procesamiento del stream (10 minutos)
    const STREAM_PROCESSING_TIMEOUT = 10 * 60 * 1000; // 10 minutos
    const CHUNK_TIMEOUT = 120 * 1000; // 2 minutos entre chunks - más generoso para streams lentos
    
    try {
      console.log(`[StreamingResponseProcessor] Iniciando procesamiento de stream con timeout ${STREAM_PROCESSING_TIMEOUT}ms...`);
      
      // Crear un timeout general para todo el procesamiento del stream
      const streamTimeout = new Promise((_, reject) => {
        setTimeout(() => {
          reject(new Error(`Stream processing timeout after ${STREAM_PROCESSING_TIMEOUT}ms`));
        }, STREAM_PROCESSING_TIMEOUT);
      });
      
      // Procesar el stream con timeout
      const streamProcessing = this.processStreamWithChunkTimeout(
        stream, 
        fullContent, 
        tokenUsage, 
        CHUNK_TIMEOUT
      );
      
      // Usar Promise.race para aplicar el timeout
      const result = await Promise.race([streamProcessing, streamTimeout]);
      fullContent = result.fullContent;
      tokenUsage = result.tokenUsage;
      
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
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error(`[StreamingResponseProcessor] Error processing streaming response:`, error);
      
      // Determinar si es un error de timeout específico
      let errorType = 'STREAM_ERROR';
      let isRecoverable = false;
      
      if (errorMessage.includes('UND_ERR_BODY_TIMEOUT') || errorMessage.includes('Body Timeout Error')) {
        errorType = 'BODY_TIMEOUT';
        isRecoverable = true;
        console.warn(`[StreamingResponseProcessor] ⏰ Body timeout detectado - contenido parcial puede ser válido`);
      } else if (errorMessage.includes('timeout') || errorMessage.includes('TIMEOUT')) {
        errorType = 'GENERAL_TIMEOUT';
        isRecoverable = fullContent.length > 100; // Si tenemos contenido parcial substancial
        console.warn(`[StreamingResponseProcessor] ⏰ Timeout general - contenido parcial: ${fullContent.length} chars`);
      } else if (errorMessage.includes('terminated')) {
        errorType = 'STREAM_TERMINATED';
        isRecoverable = fullContent.length > 50; // Contenido parcial mínimo
        console.warn(`[StreamingResponseProcessor] 🔌 Stream terminado prematuramente - contenido parcial: ${fullContent.length} chars`);
      }
      
      // Si tenemos contenido parcial válido y el error es recuperable, intentar procesarlo
      if (isRecoverable && fullContent.trim().length > 0) {
        console.log(`[StreamingResponseProcessor] 🔄 Intentando procesar contenido parcial (${fullContent.length} chars)...`);
        
        try {
          const partialResults = StreamingResponseProcessor.processStreamContent(
            fullContent, 
            command, 
            fillTargetWithContent
          );
          
          // Agregar metadata sobre el error al resultado
          const enhancedResults = partialResults.map(result => ({
            ...result,
            _metadata: {
              partial: true,
              error_type: errorType,
              error_message: errorMessage,
              content_length: fullContent.length,
              recovered_at: new Date().toISOString()
            }
          }));
          
          const updatedCommand = {
            ...command,
            results: enhancedResults,
            updated_at: new Date().toISOString()
          };
          
          console.log(`[StreamingResponseProcessor] ✅ Recuperación exitosa con contenido parcial`);
          
          return {
            status: 'completed', // Marcar como completado ya que recuperamos contenido
            results: enhancedResults,
            updatedCommand: updatedCommand,
            inputTokens: tokenUsage.prompt_tokens,
            outputTokens: tokenUsage.completion_tokens,
            warning: `Partial content recovered after ${errorType}: ${errorMessage}`
          };
          
        } catch (recoveryError) {
          console.error(`[StreamingResponseProcessor] ❌ Error en recuperación de contenido parcial:`, recoveryError);
        }
      }
      
      // Si no se puede recuperar, devolver error estándar
      const errorResults = [{
        error: `Stream processing failed: ${errorMessage}`,
        error_type: errorType,
        content_length: fullContent.length,
        partial_content: fullContent.length > 0 ? fullContent.substring(0, 200) + '...' : null
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
        error: `Stream processing failed: ${errorMessage}`
      };
    }
  }

  /**
   * Procesa el stream con timeout entre chunks para detectar streams colgados
   */
  private static async processStreamWithChunkTimeout(
    stream: any,
    initialContent: string,
    initialTokenUsage: any,
    chunkTimeout: number
  ): Promise<{ fullContent: string, tokenUsage: any }> {
    let fullContent = initialContent;
    let tokenUsage = { ...initialTokenUsage };
    let lastChunkTime = Date.now();
    let chunkCount = 0;
    
    console.log(`[StreamingResponseProcessor] Procesando stream con timeout de chunk: ${chunkTimeout}ms`);
    
    try {
      // Use an approach that properly handles the async iterator with timeout
      const streamProcessingPromise = (async () => {
        const streamIterator = stream[Symbol.asyncIterator]();
        
        while (true) {
          // Create a timeout for each chunk
          const chunkTimeoutPromise = new Promise<never>((_, reject) => {
            setTimeout(() => {
              const timeSinceLastChunk = Date.now() - lastChunkTime;
              reject(new Error(`Chunk timeout: No data received for ${timeSinceLastChunk}ms`));
            }, chunkTimeout);
          });
          
          // Race between getting next chunk and timeout
          let chunkResult: IteratorResult<any>;
          try {
            chunkResult = await Promise.race([
              streamIterator.next(),
              chunkTimeoutPromise
            ]);
          } catch (timeoutError) {
            // Timeout occurred
            throw timeoutError;
          }
          
          // Check if stream is done
          if (chunkResult.done) {
            break;
          }
          
          const chunk = chunkResult.value;
          const currentTime = Date.now();
          chunkCount++;
          lastChunkTime = currentTime;
          
          // Process chunk content
          if (chunk.choices?.[0]?.delta?.content) {
            const deltaContent = chunk.choices[0].delta.content;
            fullContent += deltaContent;
            
            // Log progress más frecuente para detectar problemas
            if (fullContent.length % 500 === 0) {
              console.log(`[StreamingResponseProcessor] Stream progress: ${fullContent.length} characters received in ${chunkCount} chunks...`);
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
        
        console.log(`[StreamingResponseProcessor] Stream completed successfully. Total content length: ${fullContent.length}, chunks: ${chunkCount}`);
        console.log(`[StreamingResponseProcessor] Final content preview: ${fullContent.substring(0, 200)}...`);
        
        return { fullContent, tokenUsage };
      })();
      
      // Execute the stream processing
      const result = await streamProcessingPromise;
      return result;
      
    } catch (error) {
      console.error(`[StreamingResponseProcessor] Error en procesamiento de chunks:`, error);
      
      // Log additional context for debugging
      const timeSinceStart = Date.now() - (lastChunkTime - (chunkCount > 0 ? 0 : Date.now()));
      console.error(`[StreamingResponseProcessor] Debug info: chunks received: ${chunkCount}, content length: ${fullContent.length}, time since start: ${timeSinceStart}ms`);
      
      throw error;
    }
  }

  /**
   * Procesa el contenido acumulado del stream
   */
  static processStreamContent(
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
