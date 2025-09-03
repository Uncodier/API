import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { performStructuredAnalysis } from '@/lib/services/structured-analyzer-service';
import { preprocessHtml, defaultOptions, aggressiveOptions, conservativeOptions } from '@/lib/utils/html-preprocessor';
import { analyzeWithConversationApi, sendConversationRequest } from '@/lib/services/conversation-client';
import { continueJsonGeneration, isIncompleteJson, attemptJsonRepair } from '@/lib/services/continuation-service';
import { StructuredAnalysisResponse } from '@/lib/types/analyzer-types';
import { createSiteAnalysis, updateSiteAnalysis, updateSiteAnalysisStatus } from '@/lib/database/site-analysis-db';
import { getSiteAnalysisFromCache, saveSiteAnalysisToCache } from '@/lib/services/site-analysis-cache-service';

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

// Define a TypeScript interface for the options
interface AnalysisOptions {
  timeout: number;
  depth: number;
  includeScreenshot: boolean;
  userAgent?: string;
  provider?: 'anthropic' | 'openai' | 'gemini';
  modelId?: string;
  ignoreSSL?: boolean;
  saveToDatabase: boolean;
  skipCache: boolean;
  cacheTtl?: number;
}

// Define options schema with caching options
const optionsSchema = z.object({
  timeout: z.number().int().positive().default(30000),
  depth: z.number().int().min(1).max(5).default(2),
  includeScreenshot: z.boolean().default(true),
  userAgent: z.string().optional(),
  provider: z.enum(['anthropic', 'openai', 'gemini']).optional(),
  modelId: z.string().optional(),
  ignoreSSL: z.boolean().default(false),
  saveToDatabase: z.boolean().default(false),
  skipCache: z.boolean().default(false),
  cacheTtl: z.number().int().positive().optional()
});

// Schema for structure analysis
const structureAnalysisSchema = z.object({
  url: z.string().url('Debe ser una URL válida'),
  htmlContent: z.string().optional(),
  screenshot: z.string().optional(),
  site_id: z.string().uuid('ID del sitio debe ser un UUID válido').optional(),
  user_id: z.string().uuid('ID del usuario debe ser un UUID válido').optional(),
  options: optionsSchema.optional()
});

export async function POST(request: NextRequest) {
  const startTime = Date.now();
  
  try {
    // Parse the request body
    const body = await request.json();
    
    // Validate and parse the request JSON
    try {
      const validatedData = structureAnalysisSchema.parse(body);
      const url = validatedData.url;
      const htmlContent = validatedData.htmlContent;
      const screenshot = validatedData.screenshot;
      const site_id = validatedData.site_id;
      const user_id = validatedData.user_id;
      
      // Cast the options to our interface with defaults
      const options: AnalysisOptions = {
        timeout: validatedData.options?.timeout || 30000,
        depth: validatedData.options?.depth || 2,
        includeScreenshot: validatedData.options?.includeScreenshot ?? true,
        userAgent: validatedData.options?.userAgent,
        provider: validatedData.options?.provider,
        modelId: validatedData.options?.modelId,
        ignoreSSL: validatedData.options?.ignoreSSL ?? false,
        saveToDatabase: validatedData.options?.saveToDatabase ?? false,
        skipCache: validatedData.options?.skipCache ?? false,
        cacheTtl: validatedData.options?.cacheTtl
      };
      
      console.log(`[StructureRoute] Solicitud validada. URL: ${url}`);
      console.log(`[StructureRoute] HTML proporcionado: ${htmlContent ? `Si (${htmlContent.length} bytes)` : 'No'}`);
      console.log(`[StructureRoute] Screenshot proporcionado: ${screenshot ? 'Si' : 'No'}`);
      
      let analysisId: string | undefined;
      let dbError: string | undefined;
      
      // Extract caching options
      const skipCache = options.skipCache;
      const cacheTtl = options.cacheTtl || 86400; // Default to 1 day
      
      // Check Redis cache if caching is not skipped
      if (!skipCache) {
        try {
          const cachedResult = await getSiteAnalysisFromCache(url);
          if (cachedResult) {
            console.log(`[StructureRoute] Using cached analysis for ${url}`);
            
            // Return the cached structured analysis response
            return NextResponse.json({
              url,
              structuredAnalysis: cachedResult,
              requestTime: 0, // From cache so no processing time
              timestamp: new Date().toISOString(),
              fromCache: true
            }, {
              status: 200
            });
          }
        } catch (cacheError) {
          console.error(`[StructureRoute] Error retrieving from cache:`, cacheError);
          // Continue without cache
        }
      }
      
      // Create initial database record if saveToDatabase is true and site_id and user_id are provided
      if (options.saveToDatabase && site_id && user_id) {
        try {
          // Extract URL path from the full URL for the database record
          const urlObj = new URL(url);
          const urlPath = urlObj.pathname + urlObj.search;
          
          // Create a new analysis record with pending status
          const analysis = await createSiteAnalysis({
            site_id,
            url_path: urlPath, // Use the URL path for the database record
            structure: null,
            user_id,
            status: 'processing',
            request_time: 0,
            provider: options.provider || 'anthropic',
            model_id: options.modelId || 'claude-3-opus-20240229'
          });
          
          if (analysis) {
            analysisId = analysis.id;
            console.log(`[StructureRoute] Created pending analysis record with ID: ${analysisId}`);
          } else {
            dbError = 'Failed to create analysis record in the database';
            console.error(`[StructureRoute] ${dbError}`);
          }
        } catch (error) {
          dbError = error instanceof Error ? error.message : 'Unknown database error';
          console.error(`[StructureRoute] Error creating analysis record:`, error);
        }
      }
      
      try {
        // Prepare analysis options
        const analysisOptions = {
          timeout: options.timeout,
          depth: options.depth,
          includeScreenshot: options.includeScreenshot,
          userAgent: options.userAgent,
          provider: options.provider,
          modelId: options.modelId,
          ignoreSSL: options.ignoreSSL,
          language: 'es' as 'es', // Default to Spanish
          htmlContent,
          screenshot
        };
        
        console.log(`[StructureRoute] Iniciando análisis estructurado con profundidad ${analysisOptions.depth}`);
        
        // Perform the structured analysis
        const result = await performStructuredAnalysis(url, analysisOptions);
          
        const endTime = Date.now();
        const requestTime = endTime - startTime;
        
        console.log(`Análisis estructurado: Completado en ${requestTime / 1000} segundos`);
        
        // Cache the result if caching is not skipped
        if (!skipCache && result && 'site_info' in result) {
          try {
            await saveSiteAnalysisToCache(url, result, cacheTtl);
            console.log(`[StructureRoute] Cached analysis for ${url}`);
          } catch (cacheError) {
            console.error(`[StructureRoute] Error caching analysis:`, cacheError);
            // Continue without caching
          }
        }
        
        // Save the completed analysis to the database if requested
        if (options.saveToDatabase && site_id && user_id) {
          try {
            // Extract URL path from the full URL for database update
            const urlObj = new URL(url);
            const urlPath = urlObj.pathname + urlObj.search;
            
            // If we already have an analysis ID, update it with the final result
            if (analysisId) {
              await updateSiteAnalysis(analysisId, {
                structure: result,
                status: 'completed',
                request_time: requestTime,
                provider: options.provider || 'anthropic',
                model_id: options.modelId || 'claude-3-opus-20240229'
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
                provider: options.provider || 'anthropic',
                model_id: options.modelId || 'claude-3-opus-20240229'
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
        
        // Return the structured analysis response
        return NextResponse.json({
          url,
          structuredAnalysis: result,
          requestTime,
          timestamp: new Date().toISOString(),
          analysis_id: analysisId,
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
        modelId: "gpt-5-nano",
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