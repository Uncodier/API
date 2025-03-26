import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { performStructuredAnalysis } from '@/lib/services/structured-analyzer-service';
import { preprocessHtml, defaultOptions, aggressiveOptions, conservativeOptions } from '@/lib/utils/html-preprocessor';
import { analyzeWithConversationApi, sendConversationRequest } from '@/lib/services/conversation-client';
import { continueJsonGeneration, isIncompleteJson, attemptJsonRepair } from '@/lib/services/continuation-service';
import { StructuredAnalysisResponse } from '@/lib/types/analyzer-types';
import { createSiteAnalysis, updateSiteAnalysis, updateSiteAnalysisStatus } from '@/lib/database/site-analysis-db';

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
  site_id: z.string().uuid('ID del sitio debe ser un UUID válido').optional(),
  user_id: z.string().uuid('ID del usuario debe ser un UUID válido').optional(),
  options: z.object({
    timeout: z.number().min(5000).max(60000).default(30000),
    userAgent: z.string().optional(),
    depth: z.number().min(1).max(3).default(2),
    includeScreenshot: z.boolean().default(true),
    provider: z.string().optional(),
    modelId: z.string().optional(),
    ignoreSSL: z.boolean().default(false),
    saveToDatabase: z.boolean().default(false)
  }).optional(),
});

export async function POST(request: NextRequest) {
  try {
    // Get and validate the request body
    const body = await request.json();
    console.log(`[StructureRoute] Procesando solicitud POST para análisis estructurado`);
    
    try {
      const { url, htmlContent, screenshot, site_id, user_id, options = { timeout: 30000, depth: 2, includeScreenshot: true, saveToDatabase: false } } = RequestSchema.parse(body);
      console.log(`[StructureRoute] Solicitud validada. URL: ${url}`);
      console.log(`[StructureRoute] HTML proporcionado: ${htmlContent ? `Si (${htmlContent.length} bytes)` : 'No'}`);
      console.log(`[StructureRoute] Screenshot proporcionado: ${screenshot ? 'Si' : 'No'}`);
      
      // Create initial database record if saveToDatabase is true and site_id and user_id are provided
      let analysisId = null;
      let dbError = null;
      
      if (options.saveToDatabase && site_id && user_id) {
        try {
          console.log(`[StructureRoute] Creating initial database record for site analysis`);
          console.log(`[StructureRoute] site_id: ${site_id}, user_id: ${user_id}`);
          
          // Check if the analysis table exists
          const { checkSiteAnalysisTableExists } = await import('@/lib/database/site-analysis-db');
          const tableExists = await checkSiteAnalysisTableExists();
          
          if (!tableExists) {
            console.error('[StructureRoute] The analysis table does not exist in the database');
            console.error('[StructureRoute] Please check your database configuration');
            dbError = 'The analysis table does not exist. Please contact the administrator.';
          } else {
            // Extract URL path from the full URL
            const urlObj = new URL(url);
            const urlPath = urlObj.pathname + urlObj.search;
            
            // Create an initial processing record in the database
            const initialAnalysis = await createSiteAnalysis({
              site_id,
              url_path: urlPath,
              structure: { status: 'processing', message: 'Analysis in progress' },
              user_id,
              status: 'processing',
              request_time: 0, // Will update this once the analysis is complete
              provider: (options as any).provider || 'anthropic',
              model_id: (options as any).modelId || 'claude-3-opus-20240229'
            });
            
            if (initialAnalysis) {
              analysisId = initialAnalysis.id;
              console.log(`[StructureRoute] Initial analysis record created with ID: ${analysisId}`);
            } else {
              console.error(`[StructureRoute] Failed to create initial analysis record`);
              dbError = 'Failed to create initial analysis record in the database';
            }
          }
        } catch (error) {
          console.error(`[StructureRoute] Error creating initial database record:`, error);
          dbError = error instanceof Error ? error.message : 'Unknown database error';
        }
      }
      
      try {
        console.log(`Starting structured analysis for ${url}`);
        
        // Extract only the options needed by performStructuredAnalysis
        const analysisOptions = {
          timeout: options.timeout,
          depth: options.depth || 2,
          includeScreenshot: options.includeScreenshot,
          // Pass htmlContent in options
          htmlContent,
          // Pass screenshot in options
          screenshot
        };
        
        console.log(`[StructureRoute] Opciones de análisis preparadas:`, JSON.stringify({
          timeout: analysisOptions.timeout,
          depth: analysisOptions.depth,
          includeScreenshot: analysisOptions.includeScreenshot,
          htmlContentPresent: analysisOptions.htmlContent ? `Si (${analysisOptions.htmlContent.length} bytes)` : 'No'
        }));
        
        // Add optional parameters if they exist
        if ((options as any).provider) {
          (analysisOptions as any).provider = (options as any).provider as 'anthropic' | 'openai' | 'gemini';
          console.log(`[StructureRoute] Proveedor establecido: ${(analysisOptions as any).provider}`);
        }
        
        if ((options as any).modelId) {
          (analysisOptions as any).modelId = (options as any).modelId;
          console.log(`[StructureRoute] Modelo ID establecido: ${(analysisOptions as any).modelId}`);
        }
        
        // If HTML content is not provided in the request, fetch it directly here
        if (!htmlContent) {
          console.log(`[StructureRoute] No HTML content provided in request, fetching directly...`);
          
          // Import the HTML preprocessing utilities
          const { preprocessHtml } = await import('@/lib/utils/html-preprocessor');
          
          try {
            // Use the same preprocessing options as in prepareAnalysisData
            const preprocessOptions = {
              removeScripts: true,
              removeStyles: true,
              removeComments: true,
              removeInlineStyles: false,
              removeDataAttributes: false,
              simplifyClassNames: false,
              preserveSemanticElements: true,
              preserveHeadings: true,
              preserveForms: true,
              preserveLinks: true,
              preserveImages: true,
              simplifyImageAttributes: true,
              optimizeSvgs: true,
              preserveNavigation: true,
              preserveCTAs: true,
              maxTextNodeLength: 30,
              maxTextLength: 200000,
              cleanHead: true,
              cleanFooter: true,
              headExcludePatterns: [],
              footerExcludePatterns: []
            };
            
            // Fetch and preprocess HTML
            const preprocessResult = await preprocessHtml(url, preprocessOptions);
            
            // Store the HTML content in the options to be passed to performStructuredAnalysis
            analysisOptions.htmlContent = preprocessResult.html;
            
            console.log(`[StructureRoute] HTML content fetched directly: ${preprocessResult.html.length} bytes`);
          } catch (htmlError) {
            console.error(`[StructureRoute] Error fetching HTML directly:`, htmlError);
          }
        }
        
        // If HTML is present, log a sample
        if (analysisOptions.htmlContent) {
          console.log(`[StructureRoute] Primeros 100 caracteres del HTML:`, analysisOptions.htmlContent.substring(0, 100).replace(/\n/g, '\\n'));
        }
        
        // Deep inspect the options object to ensure htmlContent is properly structured
        const inspectObject = (obj: any, path = 'analysisOptions') => {
          console.log(`[StructureRoute] Inspecting object at path "${path}":`);
          for (const key of Object.keys(obj)) {
            const value = obj[key];
            if (typeof value === 'object' && value !== null) {
              console.log(`[StructureRoute] Property ${path}.${key} is an object with keys: ${Object.keys(value).join(', ')}`);
              inspectObject(value, `${path}.${key}`); // Recursive inspection
            } else if (typeof value === 'string') {
              const preview = value.length > 50 ? `${value.substring(0, 50)}... (${value.length} chars)` : value;
              console.log(`[StructureRoute] Property ${path}.${key} is a string: ${preview}`);
            } else {
              console.log(`[StructureRoute] Property ${path}.${key} is type ${typeof value}: ${value}`);
            }
          }
        };
        
        console.log(`[StructureRoute] Deep inspection of analysisOptions before calling performStructuredAnalysis:`);
        inspectObject(analysisOptions);
        
        // Call the standalone structured analyzer function
        const startTime = Date.now();
        console.log(`[StructureRoute] Llamando a performStructuredAnalysis con los siguientes datos:`, JSON.stringify({
          url,
          htmlContentPresent: analysisOptions.htmlContent ? `Si (${analysisOptions.htmlContent.length} bytes)` : 'No',
          screenshotPresent: analysisOptions.screenshot ? 'Si' : 'No',
          timeout: analysisOptions.timeout,
          provider: (analysisOptions as any).provider
        }));
        
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
            maxRetries: 3,
            // Use the HTML content that we've either received in the request or fetched directly
            htmlContent: analysisOptions.htmlContent
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
          
          // Update the database record if we have an ID
          if (analysisId && options.saveToDatabase) {
            try {
              await updateSiteAnalysisStatus(analysisId, 'failed');
              console.log(`[StructureRoute] Updated analysis record ${analysisId} status to 'failed'`);
            } catch (updateError) {
              console.error(`[StructureRoute] Error updating analysis status:`, updateError);
            }
          }
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
                
                // Create a special continuation message that includes the HTML content if available
                const specialMessage = analysisOptions.htmlContent 
                  ? {
                      role: 'user' as 'system' | 'user' | 'assistant',
                      content: `Please continue exactly where you left off and complete the JSON response. I'm including the HTML content of the site to help you complete the analysis:\n\n${analysisOptions.htmlContent.substring(0, 15000)}${analysisOptions.htmlContent.length > 15000 ? '... [HTML truncated] ...' : ''}`
                    }
                  : continuationMessage;
                
                const response = await sendConversationRequest({
                  messages: [specialMessage],
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
        
        // Save the completed analysis to the database if requested
        if (options.saveToDatabase && site_id && user_id) {
          try {
            // Extract URL path from the full URL
            const urlObj = new URL(url);
            const urlPath = urlObj.pathname + urlObj.search;
            
            // If we already have an analysis ID, update it with the final result
            if (analysisId) {
              await updateSiteAnalysis(analysisId, {
                structure: result,
                status: 'completed',
                request_time: requestTime,
                provider: (analysisOptions as any).provider || 'anthropic',
                model_id: (analysisOptions as any).modelId || 'claude-3-opus-20240229'
              });
              console.log(`[StructureRoute] Updated analysis record ${analysisId} with final results`);
            } else if (!dbError) {
              // Only try to create a new record if there wasn't a previous database error
              // Create a new analysis record
              const analysis = await createSiteAnalysis({
                site_id,
                url_path: urlPath,
                structure: result,
                user_id,
                status: 'completed',
                request_time: requestTime,
                provider: (analysisOptions as any).provider || 'anthropic',
                model_id: (analysisOptions as any).modelId || 'claude-3-opus-20240229'
              });
              
              if (analysis) {
                analysisId = analysis.id;
                console.log(`[StructureRoute] Created analysis record with ID: ${analysisId}`);
              } else {
                console.error(`[StructureRoute] Failed to create analysis record`);
                dbError = 'Failed to create analysis record in the database';
              }
            }
          } catch (error) {
            console.error(`[StructureRoute] Error saving analysis to database:`, error);
            dbError = error instanceof Error ? error.message : 'Unknown database error';
          }
        }
        
        // Return the structured analysis response, including any database operation details
        return NextResponse.json({
          url,
          structuredAnalysis: result,
          requestTime,
          timestamp: new Date().toISOString(),
          analysis_id: analysisId, // Include the analysis ID in the response if we saved to the database
          database_status: dbError ? 'error' : (analysisId ? 'success' : 'not_saved'),
          database_error: dbError
        }, {
          status: 200
        });
        
      } catch (analysisError) {
        console.error('Error durante el análisis estructurado:', analysisError);
        
        // Update database record if we have an ID
        if (analysisId && options.saveToDatabase) {
          try {
            await updateSiteAnalysisStatus(analysisId, 'failed');
            console.log(`[StructureRoute] Updated analysis record ${analysisId} status to 'failed'`);
          } catch (updateError) {
            console.error(`[StructureRoute] Error updating analysis status:`, updateError);
          }
        }
        
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
    usage: "Envía una solicitud POST con un objeto JSON que contenga la propiedad 'url'. Para un análisis más preciso, incluye el HTML del sitio en la propiedad 'htmlContent'.",
    example: { 
      url: "https://example.com",
      htmlContent: "<html>...</html>", // HTML content for analysis
      screenshot: "base64encodedimage", // Optional screenshot
      site_id: "uuid-of-the-site", // Site ID for database storage
      user_id: "uuid-of-the-user", // User ID for database storage
      options: {
        timeout: 30000,
        depth: 2,
        includeScreenshot: true,
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        provider: "openai",
        modelId: "gpt-4o",
        ignoreSSL: false,
        saveToDatabase: true // Set to true to save the analysis to the database
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
          selector: "selector.con-clase[atributo='valor']:nth-child(1), #id-elemento",
          classes: ["clase1", "clase2"],
          content_type: "tipo de contenido",
          dynamic: true,
          content_blocks: [
            {
              description: "texto o descripción del contenido",
              selector: "selector único del elemento",
              dynamic: false
            }
          ],
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