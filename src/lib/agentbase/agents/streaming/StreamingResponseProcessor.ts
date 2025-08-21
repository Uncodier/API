/**
 * StreamingResponseProcessor - Maneja el procesamiento de respuestas streaming del LLM
 */
import { DbCommand, CommandExecutionResult } from '../../models/types';
import { CommandCache } from '../../services/command/CommandCache';
import { StreamingMonitor } from '../../utils/StreamingMonitor';

export class StreamingResponseProcessor {
  // Concurrency control to prevent resource exhaustion
  private static activeStreams = new Set<string>();
  private static readonly MAX_CONCURRENT_STREAMS = 5; // Increased from 3 to 5
  private static readonly STREAM_QUEUE: Array<{
    resolve: (value: void) => void;
    reject: (error: any) => void;
    commandId: string;
    processor: () => Promise<any>;
  }> = [];

  // Circuit breaker for streaming failures - more lenient settings
  private static failureCount = 0;
  private static lastFailureTime = 0;
  private static readonly MAX_FAILURES = 8; // Increased from 5 to 8
  private static readonly FAILURE_WINDOW = 10 * 60 * 1000; // 10 minutes (increased from 5)
  private static readonly CIRCUIT_BREAKER_TIMEOUT = 1 * 60 * 1000; // 1 minute (reduced from 2)

  // Socket error retry tracking
  private static socketRetryCount = new Map<string, number>();
  private static readonly MAX_SOCKET_RETRIES = 2;
  private static readonly SOCKET_RETRY_DELAY = 1000; // 1 second

  // Command processing locks to prevent race conditions
  private static commandLocks = new Map<string, Promise<any>>();

  /**
   * Check if circuit breaker should prevent new streams
   */
  private static shouldBlockStream(): boolean {
    const now = Date.now();
    
    // Reset failure count if window has passed
    if (now - this.lastFailureTime > this.FAILURE_WINDOW) {
      this.failureCount = 0;
    }
    
    // Block if too many failures recently
    if (this.failureCount >= this.MAX_FAILURES) {
      const timeSinceLastFailure = now - this.lastFailureTime;
      if (timeSinceLastFailure < this.CIRCUIT_BREAKER_TIMEOUT) {
        console.warn(`[StreamingResponseProcessor] Circuit breaker OPEN: ${this.failureCount} failures in window. Blocking for ${Math.round((this.CIRCUIT_BREAKER_TIMEOUT - timeSinceLastFailure) / 1000)}s more`);
        return true;
      } else {
        // Reset after timeout
        console.log(`[StreamingResponseProcessor] Circuit breaker RESET: Timeout expired, allowing streams again`);
        this.failureCount = 0;
      }
    }
    
    return false;
  }

  /**
   * Record a streaming failure for circuit breaker
   */
  private static recordFailure(): void {
    this.failureCount++;
    this.lastFailureTime = Date.now();
    console.warn(`[StreamingResponseProcessor] Failure recorded: ${this.failureCount}/${this.MAX_FAILURES} in current window`);
  }

  /**
   * Check if a socket error should be retried
   */
  private static shouldRetrySocketError(commandId: string, error: any): boolean {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    const isSocketError = errorMessage.includes('terminated') || 
                         errorMessage.includes('UND_ERR_SOCKET') || 
                         errorMessage.includes('other side closed') ||
                         errorMessage.includes('socket hang up') ||
                         errorMessage.includes('ECONNRESET') ||
                         errorMessage.includes('EPIPE') ||
                         error.code === 'UND_ERR_SOCKET';

    if (!isSocketError) return false;

    const currentRetries = this.socketRetryCount.get(commandId) || 0;
    return currentRetries < this.MAX_SOCKET_RETRIES;
  }

  /**
   * Record a socket retry attempt
   */
  private static recordSocketRetry(commandId: string): void {
    const currentRetries = this.socketRetryCount.get(commandId) || 0;
    this.socketRetryCount.set(commandId, currentRetries + 1);
    console.warn(`[StreamingResponseProcessor] Socket retry ${currentRetries + 1}/${this.MAX_SOCKET_RETRIES} for command ${commandId}`);
  }

  /**
   * Clear socket retry count for a command
   */
  private static clearSocketRetries(commandId: string): void {
    this.socketRetryCount.delete(commandId);
  }

  /**
   * Acquire a stream slot with concurrency control
   */
  private static async acquireStreamSlot(commandId: string): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.activeStreams.size < this.MAX_CONCURRENT_STREAMS) {
        this.activeStreams.add(commandId);
        console.log(`[StreamingResponseProcessor] Stream slot acquired for ${commandId}. Active: ${this.activeStreams.size}/${this.MAX_CONCURRENT_STREAMS}`);
        resolve();
      } else {
        console.log(`[StreamingResponseProcessor] Stream slot queued for ${commandId}. Queue size: ${this.STREAM_QUEUE.length + 1}`);
        this.STREAM_QUEUE.push({
          resolve,
          reject,
          commandId,
          processor: () => Promise.resolve()
        });
      }
    });
  }

  /**
   * Release a stream slot and process next in queue
   */
  private static releaseStreamSlot(commandId: string): void {
    this.activeStreams.delete(commandId);
    this.clearSocketRetries(commandId); // Clean up retry tracking
    console.log(`[StreamingResponseProcessor] Stream slot released for ${commandId}. Active: ${this.activeStreams.size}/${this.MAX_CONCURRENT_STREAMS}`);
    
    // Process next in queue
    if (this.STREAM_QUEUE.length > 0) {
      const next = this.STREAM_QUEUE.shift()!;
      this.activeStreams.add(next.commandId);
      console.log(`[StreamingResponseProcessor] Processing queued stream for ${next.commandId}. Queue remaining: ${this.STREAM_QUEUE.length}`);
      next.resolve(undefined);
    }
  }
  /**
   * Acquire a processing lock for a command to prevent race conditions
   */
  private static async acquireCommandLock(commandId: string): Promise<void> {
    // If there's already a lock for this command, wait for it
    const existingLock = this.commandLocks.get(commandId);
    if (existingLock) {
      console.log(`[StreamingResponseProcessor] Waiting for existing lock on command: ${commandId}`);
      try {
        await existingLock;
      } catch (error) {
        // Ignore errors from previous processing, we'll try again
        console.log(`[StreamingResponseProcessor] Previous lock failed, proceeding: ${commandId}`);
      }
    }
  }

  /**
   * Release a processing lock for a command
   */
  private static releaseCommandLock(commandId: string): void {
    this.commandLocks.delete(commandId);
    console.log(`[StreamingResponseProcessor] Released command lock: ${commandId}`);
  }

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
    const commandId = command.id || 'unknown';
    
    // Acquire command lock to prevent race conditions
    await this.acquireCommandLock(commandId);
    
    // Create a processing promise and store it in locks
    const processingPromise = this.processStreamingResponseInternal(
      stream, command, modelInfo, fillTargetWithContent
    );
    
    this.commandLocks.set(commandId, processingPromise);
    
    try {
      const result = await processingPromise;
      return result;
    } finally {
      this.releaseCommandLock(commandId);
    }
  }

  /**
   * Internal method that does the actual streaming processing
   */
  private static async processStreamingResponseInternal(
    stream: any, 
    command: DbCommand, 
    modelInfo: any,
    fillTargetWithContent: (target: any, content: any) => any
  ): Promise<CommandExecutionResult> {
    const commandId = command.id || 'unknown';
    
    // Check circuit breaker
    if (this.shouldBlockStream()) {
      return {
        status: 'failed',
        results: [{
          error: 'Circuit breaker is OPEN due to recent streaming failures. Please try again later.',
          error_type: 'CIRCUIT_BREAKER_OPEN',
          content_length: 0,
          partial_content: null
        }],
        updatedCommand: command,
        inputTokens: 0,
        outputTokens: 0,
        error: 'Circuit breaker is OPEN'
      };
    }
    
    // Acquire stream slot with concurrency control
    await this.acquireStreamSlot(commandId);
    
    // Start monitoring this stream
    StreamingMonitor.startMonitoring(commandId);
    
    let fullContent = '';
    let tokenUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
    let heartbeatInterval: NodeJS.Timeout | null = null;
    
    // Timeout específico para el procesamiento del stream - DEBE ser menor que Vercel maxDuration
    const STREAM_PROCESSING_TIMEOUT = 4 * 60 * 1000; // 4 minutos (menor que 5min de Vercel)
    const CHUNK_TIMEOUT = 30 * 1000; // 30 segundos entre chunks (más agresivo)
    
    try {
      console.log(`[StreamingResponseProcessor] Iniciando procesamiento de stream con timeout ${STREAM_PROCESSING_TIMEOUT}ms...`);
      
      // Early termination check to prevent Vercel timeout
      const startTime = Date.now();
      const VERCEL_SAFETY_MARGIN = 30 * 1000; // 30 seconds before Vercel timeout
      const VERCEL_MAX_DURATION = 300 * 1000; // 5 minutes
      const SAFE_PROCESSING_TIME = VERCEL_MAX_DURATION - VERCEL_SAFETY_MARGIN;
      
      // Heartbeat para detectar streams colgados
      let lastHeartbeat = Date.now();
      heartbeatInterval = setInterval(() => {
        const timeSinceLastHeartbeat = Date.now() - lastHeartbeat;
        const totalElapsed = Date.now() - startTime;
        
        if (timeSinceLastHeartbeat > CHUNK_TIMEOUT * 1.5) {
          console.warn(`[StreamingResponseProcessor] ⚠️ Stream heartbeat warning: ${timeSinceLastHeartbeat}ms since last activity for ${commandId}`);
        }
        
        // Early termination warning
        if (totalElapsed > SAFE_PROCESSING_TIME * 0.8) {
          console.warn(`[StreamingResponseProcessor] ⚠️ Approaching Vercel timeout limit: ${totalElapsed}ms elapsed for ${commandId}`);
        }
      }, 15000); // Check every 15 seconds (more frequent monitoring)
      
      // Crear un timeout general para todo el procesamiento del stream
      // Use the safer timeout to prevent Vercel timeout
      const effectiveTimeout = Math.min(STREAM_PROCESSING_TIMEOUT, SAFE_PROCESSING_TIME);
      const streamTimeout = new Promise((_, reject) => {
        setTimeout(() => {
          if (heartbeatInterval) {
            clearInterval(heartbeatInterval);
          }
          reject(new Error(`Stream processing timeout after ${effectiveTimeout}ms (Vercel safety limit)`));
        }, effectiveTimeout);
      });
      
      // Procesar el stream con timeout
      const streamProcessing = this.processStreamWithChunkTimeout(
        stream, 
        fullContent, 
        tokenUsage, 
        CHUNK_TIMEOUT,
        commandId, // Pass commandId for monitoring
        () => { lastHeartbeat = Date.now(); } // Update heartbeat on chunk received
      );
      
      // Usar Promise.race para aplicar el timeout
      const result = await Promise.race([streamProcessing, streamTimeout]) as { fullContent: string; tokenUsage: any };
      if (heartbeatInterval) {
        clearInterval(heartbeatInterval); // Clean up heartbeat
      }
      fullContent = result.fullContent;
      tokenUsage = result.tokenUsage;
      
      console.log(`[StreamingResponseProcessor] Stream completed. Total content length: ${fullContent.length}`);
      console.log(`[StreamingResponseProcessor] Final content preview: ${fullContent.substring(0, 200)}...`);
      
      // Complete monitoring with success
      StreamingMonitor.completeMonitoring(commandId, 'completed');
      
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
        results: results,
        status: 'completed' // Asegurar que el estado en caché sea correcto
      });
      
      console.log(`✅ [StreamingResponseProcessor] Comando procesado exitosamente: ${commandId}`);
      console.log(`📊 [StreamingResponseProcessor] Tokens: input=${tokenUsage.prompt_tokens}, output=${tokenUsage.completion_tokens}`);
      console.log(`📋 [StreamingResponseProcessor] Resultados: ${results.length} elementos`);
      
      return {
        status: 'completed',
        results,
        updatedCommand: updatedCommand,
        inputTokens: tokenUsage.prompt_tokens,
        outputTokens: tokenUsage.completion_tokens
      };
      
    } catch (error) {
      // Clean up heartbeat interval
      if (heartbeatInterval) {
        clearInterval(heartbeatInterval);
        heartbeatInterval = null;
      }
      
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error(`[StreamingResponseProcessor] Error processing streaming response:`, error);
      
      // Record error in monitoring
      StreamingMonitor.recordError(commandId, errorMessage);
      
      // Record failure for circuit breaker
      this.recordFailure();
      
      // CRITICAL FIX: Extract preserved partial content from custom error
      if ((error as any).partialContent) {
        fullContent = (error as any).partialContent;
        tokenUsage = (error as any).partialTokenUsage || tokenUsage;
        console.log(`[StreamingResponseProcessor] 🔄 Extracted preserved content: ${fullContent.length} chars from error`);
      }
      
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
        StreamingMonitor.recordTimeout(commandId);
      } else if (errorMessage.includes('terminated') || 
                 errorMessage.includes('UND_ERR_SOCKET') || 
                 errorMessage.includes('other side closed') ||
                 errorMessage.includes('socket hang up') ||
                 errorMessage.includes('ECONNRESET') ||
                 errorMessage.includes('EPIPE') ||
                 (error as any).code === 'UND_ERR_SOCKET' ||
                 (error as any).isSocketError) {
        errorType = 'STREAM_TERMINATED';
        isRecoverable = fullContent.length > 50; // Contenido parcial mínimo
        console.warn(`[StreamingResponseProcessor] 🔌 Stream terminado prematuramente por error de socket - contenido parcial: ${fullContent.length} chars`);
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
      
      // Complete monitoring with failure
      StreamingMonitor.completeMonitoring(commandId, 'failed');
      
      return {
        status: 'failed',
        results: errorResults,
        updatedCommand: updatedCommand,
        inputTokens: tokenUsage.prompt_tokens,
        outputTokens: tokenUsage.completion_tokens,
        error: `Stream processing failed: ${errorMessage}`
      };
    } finally {
      // Clean up heartbeat interval if still active
      if (heartbeatInterval) {
        clearInterval(heartbeatInterval);
        heartbeatInterval = null;
      }
      
      // Always release the stream slot
      this.releaseStreamSlot(commandId);
    }
  }

  /**
   * Procesa el stream con timeout entre chunks para detectar streams colgados
   */
  private static async processStreamWithChunkTimeout(
    stream: any,
    initialContent: string,
    initialTokenUsage: any,
    chunkTimeout: number,
    commandId: string, // Add commandId parameter
    onChunkReceived?: () => void
  ): Promise<{ fullContent: string, tokenUsage: any }> {
    let fullContent = initialContent;
    let tokenUsage = { ...initialTokenUsage };
    let lastChunkTime = Date.now();
    let chunkCount = 0;
    let currentTimeoutId: NodeJS.Timeout | null = null;
    const startTime = Date.now(); // Add startTime for logging
    
    console.log(`[StreamingResponseProcessor] Procesando stream con timeout de chunk: ${chunkTimeout}ms`);
    
    try {
      // Use an approach that properly handles the async iterator with timeout
      const streamProcessingPromise = (async () => {
        const streamIterator = stream[Symbol.asyncIterator]();
        
        while (true) {
          // Clear any existing timeout
          if (currentTimeoutId) {
            clearTimeout(currentTimeoutId);
            currentTimeoutId = null;
          }
          
          // Create a timeout for this chunk with proper cleanup
          const chunkTimeoutPromise = new Promise<never>((_, reject) => {
            currentTimeoutId = setTimeout(() => {
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
            
            // Clear timeout on successful chunk reception
            if (currentTimeoutId) {
              clearTimeout(currentTimeoutId);
              currentTimeoutId = null;
            }
          } catch (timeoutError) {
            // Clean up timeout on error
            if (currentTimeoutId) {
              clearTimeout(currentTimeoutId);
              currentTimeoutId = null;
            }
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
          
          // Update heartbeat
          if (onChunkReceived) {
            onChunkReceived();
          }
          
          // Process chunk content
          if (chunk.choices?.[0]?.delta?.content) {
            const deltaContent = chunk.choices[0].delta.content;
            fullContent += deltaContent;
            
            // Record chunk in monitoring
            const chunkDelay = currentTime - lastChunkTime;
            StreamingMonitor.recordChunk(commandId, deltaContent.length, chunkDelay);
            
            // Log progress más frecuente para detectar problemas
            if (fullContent.length % 1000 === 0 || chunkCount % 100 === 0) {
              const elapsed = Date.now() - startTime;
              console.log(`[StreamingResponseProcessor] Stream progress: ${fullContent.length} characters received in ${chunkCount} chunks (${elapsed}ms elapsed)...`);
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
      // Ensure timeout is cleaned up on any error
      if (currentTimeoutId) {
        clearTimeout(currentTimeoutId);
        currentTimeoutId = null;
      }
      
      console.error(`[StreamingResponseProcessor] Error en procesamiento de chunks:`, error);
      
      // Log additional context for debugging
      const timeSinceStart = Date.now() - (lastChunkTime - (chunkCount > 0 ? 0 : Date.now()));
      console.error(`[StreamingResponseProcessor] Debug info: chunks received: ${chunkCount}, content length: ${fullContent.length}, time since start: ${timeSinceStart}ms`);
      
      // CRITICAL FIX: Preserve partial content for socket errors and stream terminations
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      const isSocketError = errorMessage.includes('terminated') || 
                           errorMessage.includes('UND_ERR_SOCKET') || 
                           errorMessage.includes('other side closed') ||
                           errorMessage.includes('socket hang up') ||
                           errorMessage.includes('ECONNRESET') ||
                           errorMessage.includes('EPIPE') ||
                           (error as any).code === 'UND_ERR_SOCKET';
      
      if (isSocketError && fullContent.length > 0) {
        console.warn(`[StreamingResponseProcessor] 🔄 Preserving ${fullContent.length} chars of partial content from socket error: ${errorMessage}`);
        
        // Create a custom error that includes the partial content
        const preservedContentError = new Error(errorMessage);
        (preservedContentError as any).partialContent = fullContent;
        (preservedContentError as any).partialTokenUsage = tokenUsage;
        (preservedContentError as any).chunkCount = chunkCount;
        (preservedContentError as any).isSocketError = true;
        throw preservedContentError;
      }
      
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
