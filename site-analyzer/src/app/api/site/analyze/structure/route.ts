import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { performStructuredAnalysis } from '@/lib/services/structured-analyzer-service';
import { preprocessHtml, defaultOptions, aggressiveOptions, conservativeOptions } from '@/lib/utils/html-preprocessor';
import { analyzeWithConversationApi, sendConversationRequest } from '@/lib/services/conversation-client';
import { continueJsonGeneration, isIncompleteJson, attemptJsonRepair } from '@/lib/services/continuation-service';
import { StructuredAnalysisResponse } from '@/lib/types/analyzer-types';

// Extended type to handle API response with metadata
type ExtendedAnalysisResponse = StructuredAnalysisResponse & {
  _requestMetadata?: {
    conversationId?: string;
    closed?: boolean;
    timestamp?: string;
    duration?: number;
    modelType?: string;
    modelId?: string;
  }
};

// Type for error response
interface ErrorResponse {
  error: boolean;
  message: string;
  partial_result?: string;
}

// Schema for the request body
const RequestSchema = z.object({
  url: z.string().url('Debe ser una URL válida'),
  htmlContent: z.string().optional(), // HTML de la página (opcional)
  screenshot: z.string().optional(), // Captura de pantalla en Base64 (opcional)
  options: z.object({
    timeout: z.number().min(5000).max(60000).default(30000),
    userAgent: z.string().optional(),
    depth: z.number().min(1).max(3).default(2),
    includeScreenshot: z.boolean().default(true),
    provider: z.string().optional(),
    modelId: z.string().optional(),
    ignoreSSL: z.boolean().default(false)
  }).optional(),
});

export async function POST(request: NextRequest) {
  try {
    // Get and validate the request body
    const body = await request.json();
    
    try {
      const { url, options = { timeout: 30000, depth: 2, includeScreenshot: true } } = RequestSchema.parse(body);
      
      try {
        console.log(`Starting structured analysis for ${url}`);
        
        // Extract only the options needed by performStructuredAnalysis
        const analysisOptions = {
          timeout: options.timeout,
          depth: options.depth || 2,
          includeScreenshot: options.includeScreenshot
        };
        
        // Add optional parameters if they exist
        if ((options as any).provider) {
          (analysisOptions as any).provider = (options as any).provider as 'anthropic' | 'openai' | 'gemini';
        }
        
        if ((options as any).modelId) {
          (analysisOptions as any).modelId = (options as any).modelId;
        }
        
        // Call the standalone structured analyzer function
        const startTime = Date.now();
        let result: ExtendedAnalysisResponse | ErrorResponse | string = await performStructuredAnalysis(url, analysisOptions);
        
        // Check if the result is a string (possibly incomplete JSON)
        if (typeof result === 'string' && isIncompleteJson(result)) {
          console.log(`[StructuredAnalysis] Detected incomplete JSON response, attempting to continue generation`);
          
          // Use an even longer timeout for continuation
          const continuationTimeout = options.timeout * 1.5; // 50% more time for continuation
          console.log(`[StructuredAnalysis] Using extended timeout for continuation: ${continuationTimeout}ms`);
          
          // Try to continue the incomplete JSON generation
          console.log(`[StructuredAnalysis] Starting JSON continuation process...`);
          const continuationResult = await continueJsonGeneration({
            incompleteJson: result,
            modelType: (analysisOptions as any).provider || 'anthropic',
            modelId: (analysisOptions as any).modelId || 'claude-3-opus-20240229',
            siteUrl: url,
            includeScreenshot: options.includeScreenshot,
            timeout: continuationTimeout,
            maxRetries: 3
          });
          
          console.log(`[StructuredAnalysis] Continuation process completed, checking result...`);
          
          if (continuationResult.success && continuationResult.completeJson) {
            console.log(`[StructuredAnalysis] Successfully completed JSON generation after ${continuationResult.retries} retries`);
            result = continuationResult.completeJson as ExtendedAnalysisResponse;
            console.log(`[StructuredAnalysis] Complete JSON obtained, continuing with processing`);
          } else {
            console.error(`[StructuredAnalysis] Failed to complete JSON generation:`, continuationResult.error);
            
            // If we couldn't complete it, try to repair the JSON
            console.log(`[StructuredAnalysis] Attempting to repair incomplete JSON...`);
            const repairedJson = attemptJsonRepair(result);
            if (repairedJson) {
              console.log(`[StructuredAnalysis] Successfully repaired incomplete JSON`);
              result = repairedJson as ExtendedAnalysisResponse;
            } else {
              console.log(`[StructuredAnalysis] Could not repair JSON, creating error object`);
              // If we couldn't repair it, create an error object
              result = {
                error: true,
                message: "La respuesta del análisis no es un JSON válido",
                partial_result: result ? String(result).substring(0, 500) + "..." : "N/A"
              } as ErrorResponse;
            }
          }
        }
        
        // Check if the result is an object with metadata and if the conversation is not closed
        if (result && typeof result === 'object' && 'error' in result && result.error === true) {
          // Handle error response
          console.error(`[StructuredAnalysis] Error in analysis:`, result.message);
        } else if (result && typeof result === 'object' && '_requestMetadata' in result) {
          // Handle response with metadata
          const typedResult = result as ExtendedAnalysisResponse;
          console.log(`[StructuredAnalysis] Response contains metadata:`, 
            JSON.stringify({
              conversationId: typedResult._requestMetadata?.conversationId,
              closed: typedResult._requestMetadata?.closed
            }));
          
          // If the conversation is not closed, try to continue with the same conversationId
          if (typedResult._requestMetadata?.closed === false && typedResult._requestMetadata?.conversationId) {
            console.log(`[StructuredAnalysis] Conversation is not closed, starting continuation loop`);
            
            const conversationId = typedResult._requestMetadata.conversationId;
            let isClosed = false;
            let continuationResponse = typedResult;
            let maxAttempts = 5; // Maximum number of continuation attempts
            let attemptCount = 0;
            
            // Continuation loop: keep trying until the conversation is closed or max attempts reached
            while (!isClosed && attemptCount < maxAttempts) {
              attemptCount++;
              console.log(`[StructuredAnalysis] Continuation attempt ${attemptCount} of ${maxAttempts}`);
              
              // Use an even longer timeout for continuation, increasing with each attempt
              const continuationTimeout = options.timeout * (1.5 + (attemptCount * 0.1)); // Increase 10% per attempt
              console.log(`[StructuredAnalysis] Using extended timeout for continuation: ${continuationTimeout}ms`);
              
              try {
                // Prepare a simple message to continue the conversation
                const continuationMessage = {
                  role: 'user' as 'system' | 'user' | 'assistant',
                  content: 'Please continue exactly where you left off and complete the JSON response.'
                };
                
                // Wait a bit before trying again to give the service time
                const waitTime = 1000 * attemptCount; // Increasing wait: 1s, 2s, 3s...
                console.log(`[StructuredAnalysis] Waiting ${waitTime}ms before next attempt...`);
                await new Promise(resolve => setTimeout(resolve, waitTime));
                
                // Call the API again with the same conversationId to continue
                console.log(`[StructuredAnalysis] Continuing conversation with ID (attempt ${attemptCount}):`, conversationId);
                const response = await sendConversationRequest({
                  messages: [continuationMessage],
                  modelType: (analysisOptions as any).provider || 'anthropic',
                  modelId: (analysisOptions as any).modelId || 'claude-3-opus-20240229',
                  includeScreenshot: options.includeScreenshot,
                  siteUrl: url,
                  responseFormat: 'json',
                  timeout: continuationTimeout,
                  conversationId: conversationId
                });
                
                console.log(`[StructuredAnalysis] Continuation response received for attempt`, attemptCount);
                
                // If the continuation response is valid, update it
                if (response && typeof response === 'object') {
                  continuationResponse = response as ExtendedAnalysisResponse;
                  
                  // Check if the conversation is now closed
                  if (continuationResponse._requestMetadata && continuationResponse._requestMetadata.closed === true) {
                    console.log(`[StructuredAnalysis] Conversation successfully closed after`, attemptCount, `attempts`);
                    isClosed = true;
                    
                    // Use the final response and exit the loop
                    result = continuationResponse;
                  } else {
                    console.log(`[StructuredAnalysis] Conversation still not closed, continuing the loop`);
                  }
                } else {
                  console.error(`[StructuredAnalysis] Invalid continuation response, trying again`);
                }
              } catch (continuationError) {
                console.error(`[StructuredAnalysis] Error in attempt ${attemptCount} to continue conversation:`, continuationError);
                // Don't exit the loop, try again if attempts remain
              }
            }
            
            // When exiting the loop, check the results
            if (isClosed) {
              console.log(`[StructuredAnalysis] Continuation loop completed successfully`);
            } else {
              console.warn(`[StructuredAnalysis] Maximum attempts reached without closing the conversation`);
              // Use the last response obtained, even if not marked as closed
              result = continuationResponse;
            }
          }
        }
        
        const endTime = Date.now();
        const requestTime = endTime - startTime;
        
        console.log(`Análisis estructurado: Completado en ${requestTime / 1000} segundos`);
        
        // Return the structured analysis response
        return NextResponse.json({
          url,
          structuredAnalysis: result,
          requestTime,
          timestamp: new Date().toISOString()
        }, {
          status: 200
        });
        
      } catch (analysisError) {
        console.error('Error durante el análisis estructurado:', analysisError);
        
        // Return error details
        return NextResponse.json({
          success: false,
          error: {
            message: analysisError instanceof Error ? analysisError.message : String(analysisError),
            type: 'ANALYSIS_ERROR'
          }
        }, { status: 500 });
      }
      
    } catch (validationError) {
      if (validationError instanceof z.ZodError) {
        return NextResponse.json({ 
          success: false,
          error: {
            message: validationError.errors[0].message,
            field: validationError.errors[0].path.join('.'),
            type: 'VALIDATION_ERROR'
          }
        }, { status: 400 });
      }
      throw validationError;
    }
  } catch (error) {
    console.error('Error en la ruta de análisis estructurado:', error);
    return NextResponse.json({ 
      success: false,
      error: {
        message: 'Error interno del servidor',
        type: 'SERVER_ERROR'
      }
    }, { status: 500 });
  }
}

// GET endpoint for information
export async function GET(_request: NextRequest) {
  return NextResponse.json({
    message: "API de análisis estructurado de sitios web",
    usage: "Envía una solicitud POST con un objeto JSON que contenga la propiedad 'url'",
    example: { 
      url: "https://example.com",
      options: {
        timeout: 30000,
        depth: 2,
        includeScreenshot: true,
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        provider: "openai",
        modelId: "gpt-4o",
        ignoreSSL: false
      }
    },
    response_format: {
      site_info: {
        url: "url del sitio",
        title: "título de la página",
        description: "meta descripción o descripción inferida",
        language: "idioma detectado"
      },
      blocks: [
        {
          id: "ID del elemento",
          type: "tipo de elemento",
          selector: "selector CSS",
          classes: ["clase1", "clase2"],
          content_type: "tipo de contenido",
          relevance: {
            score: 85,
            reason: "razón de relevancia"
          }
        }
      ],
      hierarchy: {
        main_sections: ["header", "main", "footer"],
        navigation_structure: []
      },
      overview: {
        total_blocks: 15,
        primary_content_blocks: 5,
        navigation_blocks: 2,
        interactive_elements: 8
      }
    }
  });
} 