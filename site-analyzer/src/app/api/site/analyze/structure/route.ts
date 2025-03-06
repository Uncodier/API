import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { performStructuredAnalysis } from '@/lib/services/structured-analyzer-service';
import { preprocessHtml, defaultOptions, aggressiveOptions, conservativeOptions } from '@/lib/utils/html-preprocessor';

// Schema for the request body
const RequestSchema = z.object({
  url: z.string().url('Debe ser una URL válida'),
  htmlContent: z.string().optional(), // HTML de la página (opcional)
  screenshot: z.string().optional(), // Captura de pantalla en Base64 (opcional)
  options: z.object({
    timeout: z.number().min(5000).max(60000).default(30000),
    userAgent: z.string().optional(),
    depth: z.number().min(1).max(3).default(2),
    includeScreenshot: z.boolean().default(true)
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
        
        // Call the standalone structured analyzer function
        const startTime = Date.now();
        const result = await performStructuredAnalysis(url, {
          timeout: options.timeout,
          depth: options.depth || 2,
          includeScreenshot: options.includeScreenshot
        });
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
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
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