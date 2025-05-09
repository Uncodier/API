import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { personalizeHtmlForSegment, PersonalizationOptions } from '@/lib/services/html-personalization-service';
import { createApiResponse, logInfo, logError, logPersonalizationResult } from '@/lib/utils/api-response-utils';

/**
 * API DE PERSONALIZACIÓN HTML PARA SEGMENTOS
 * 
 * Esta API permite generar y aplicar personalizaciones específicas al HTML de un sitio web
 * basadas en segmentos de audiencia.
 * 
 * Es útil para adaptar dinámicamente la experiencia de usuario, el contenido y la interfaz
 * de un sitio web según las características, preferencias y necesidades de diferentes
 * segmentos de audiencia.
 * 
 * Documentación completa: /docs/api/analysis/segments/html-personalization
 */

// Esquema para validar el cuerpo de la solicitud
const RequestSchema = z.object({
  url: z.string().url('Debe ser una URL válida'),
  segment_id: z.string().min(1, 'El ID del segmento es requerido'),
  analysis_id: z.string().optional(),
  personalization_level: z.enum(['minimal', 'moderate', 'extensive']).optional().default('moderate'),
  target_elements: z.array(
    z.enum(['layout', 'navigation', 'content', 'cta', 'visuals', 'forms', 'all'])
  ).optional().default(['all']),
  implementation_method: z.enum(['js_injection', 'static_html', 'hybrid']).optional().default('js_injection'),
  user_id: z.string().optional(),
  site_id: z.string().optional(),
  target_pages: z.array(z.string()).optional(),
  device_type: z.enum(['all', 'mobile', 'desktop', 'tablet']).optional().default('all'),
  aiProvider: z.enum(['openai', 'anthropic', 'gemini']).optional(),
  aiModel: z.string().optional(),
  timeout: z.number().min(5000).max(120000).optional().default(45000),
  include_preview: z.boolean().optional().default(true),
  include_diff: z.boolean().optional().default(true),
  include_performance_impact: z.boolean().optional().default(true),
  includeScreenshot: z.boolean().optional().default(true),
  test_mode: z.boolean().optional().default(true),
});

/**
 * Manejar errores de validación y devolver una respuesta apropiada
 */
function handleValidationError(error: any): NextResponse {
  logError('PersonalizeHTML', 'Error de validación:', error);
  
  return NextResponse.json(
    { 
      error: true, 
      message: 'Error de validación de datos', 
      details: error.errors || error.message
    }, 
    { status: 400 }
  );
}

/**
 * Manejar errores generales y devolver una respuesta apropiada
 */
function handleGeneralError(error: any): NextResponse {
  logError('PersonalizeHTML', 'Error:', error);
  
  return NextResponse.json(
    { 
      error: true, 
      message: 'Error al procesar la solicitud', 
      details: error.message
    }, 
    { status: 500 }
  );
}

export async function POST(request: NextRequest) {
  try {
    // Obtener y validar el cuerpo de la solicitud
    const body = await request.json();
    logInfo('PersonalizeHTML', 'Procesando solicitud POST para personalización de HTML');

    try {
      const validatedData = RequestSchema.parse(body);
      logInfo('PersonalizeHTML', `Solicitud validada. URL: ${validatedData.url}, Segmento: ${validatedData.segment_id}`);
      
      // Configurar opciones para el servicio de personalización
      const options: PersonalizationOptions = getPersonalizationOptions(validatedData);
      
      // Medir el tiempo de ejecución
      const startTime = Date.now();
      
      // Ejecutar la personalización
      const result = await personalizeHtmlForSegment(
        validatedData.url,
        validatedData.segment_id,
        options
      );
      
      // Calcular tiempo de ejecución
      const executionTime = Date.now() - startTime;
      
      logInfo('PersonalizeHTML', `Personalización completada en ${executionTime}ms`);
      logPersonalizationResult('PersonalizeHTML', result);
      
      return createApiResponse(result, 200);
    } catch (validationError: any) {
      return handleValidationError(validationError);
    }
  } catch (error: any) {
    return handleGeneralError(error);
  }
}

export async function GET(request: NextRequest) {
  // Obtener parámetros de la URL
  const searchParams = request.nextUrl.searchParams;
  const url = searchParams.get('url');
  const segmentId = searchParams.get('segment_id');
  const siteId = searchParams.get('site_id') || 'default';
  
  // Verificar que los parámetros requeridos estén presentes
  if (!url || !segmentId) {
    return NextResponse.json(
      { 
        error: true, 
        message: 'Parámetros requeridos: url, segment_id' 
      }, 
      { status: 400 }
    );
  }
  
  try {
    // Configurar opciones básicas
    const options: PersonalizationOptions = {
      personalization_level: (searchParams.get('personalization_level') as any) || 'moderate',
      implementation_method: (searchParams.get('implementation_method') as any) || 'js_injection',
      device_type: (searchParams.get('device_type') as any) || 'all',
      test_mode: true, // Siempre usar modo de prueba en GET
      site_id: siteId,
    };
    
    // Convertir timeout a número si está presente
    const timeout = searchParams.get('timeout');
    if (timeout) {
      options.timeout = parseInt(timeout, 10);
    }
    
    // Ejecutar la personalización
    const result = await personalizeHtmlForSegment(url, segmentId, options);
    
    logPersonalizationResult('PersonalizeHTML', result, 'GET');
    return createApiResponse(result, 200);
  } catch (error: any) {
    return handleGeneralError(error);
  }
} 

/**
 * Extrae y configura las opciones de personalización a partir de los datos validados
 */
function getPersonalizationOptions(validatedData: z.infer<typeof RequestSchema>): PersonalizationOptions {
  return {
    timeout: validatedData.timeout,
    personalization_level: validatedData.personalization_level,
    target_elements: validatedData.target_elements,
    implementation_method: validatedData.implementation_method,
    user_id: validatedData.user_id,
    site_id: validatedData.site_id,
    target_pages: validatedData.target_pages,
    device_type: validatedData.device_type,
    aiProvider: validatedData.aiProvider,
    aiModel: validatedData.aiModel,
    include_preview: validatedData.include_preview,
    include_diff: validatedData.include_diff,
    include_performance_impact: validatedData.include_performance_impact,
    includeScreenshot: validatedData.includeScreenshot,
    test_mode: validatedData.test_mode,
    ...(validatedData.analysis_id && { analysis_id: validatedData.analysis_id })
  };
} 