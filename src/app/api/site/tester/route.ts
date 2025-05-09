import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'

/**
 * API TESTER
 * 
 * Esta API permite probar diferentes funcionalidades y configuraciones.
 * Es útil para verificar la integración de nuevos componentes y servicios.
 * 
 * Características principales:
 * - Respuestas en formato JSON estructurado
 * - Simulación de diferentes escenarios de respuesta
 * - Soporte para diferentes modelos de IA
 * - Personalización de parámetros de respuesta
 * 
 * Documentación completa: /docs/api/tester
 */

// Enumeraciones para tipos de datos
const ResponseTypes = [
  'success',
  'error',
  'partial',
  'timeout'
] as const;

const AiProviders = [
  'openai',
  'anthropic',
  'gemini'
] as const;

// Esquema para validar el cuerpo de la solicitud
const RequestSchema = z.object({
  // Parámetros básicos
  testType: z.enum(ResponseTypes).default('success'),
  delay: z.number().int().min(0).max(10000).default(0),
  
  // Parámetros de configuración de IA
  aiProvider: z.enum(AiProviders).optional(),
  aiModel: z.string().optional(),
  
  // Parámetros adicionales
  customData: z.record(z.any()).optional(),
  simulateError: z.boolean().optional().default(false),
  errorCode: z.number().int().min(400).max(599).optional().default(500),
  errorMessage: z.string().optional(),
  
  // Parámetros de control
  responseSize: z.enum(['small', 'medium', 'large']).optional().default('medium')
});

// Interfaz para la respuesta
interface TesterResponse {
  success: boolean;
  testType: string;
  timestamp: string;
  requestId: string;
  processingTime: number;
  aiProvider?: string;
  aiModel?: string;
  data?: any;
  customData?: any;
  error?: {
    code: number;
    message: string;
    details?: any;
  };
  metadata: {
    version: string;
    environment: string;
  };
}

// Función para generar un ID de solicitud único
function generateRequestId(): string {
  return `req_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`;
}

// Función para generar datos de ejemplo según el tamaño solicitado
function generateSampleData(size: 'small' | 'medium' | 'large'): any {
  const baseData: {
    message: string;
    status: string;
    items: Array<{
      id: string;
      name: string;
      value: number;
      active: boolean;
      tags: string[];
    }>;
  } = {
    message: "Datos de ejemplo generados para pruebas",
    status: "OK",
    items: []
  };
  
  // Generar diferentes cantidades de elementos según el tamaño
  const itemCount = size === 'small' ? 3 : size === 'medium' ? 10 : 50;
  
  for (let i = 0; i < itemCount; i++) {
    baseData.items.push({
      id: `item_${i}`,
      name: `Elemento de prueba ${i}`,
      value: Math.random() * 100,
      active: Math.random() > 0.3,
      tags: ['test', `tag_${i % 5}`, `priority_${i % 3}`]
    });
  }
  
  return baseData;
}

/**
 * POST /api/site/tester
 * 
 * Endpoint para probar diferentes escenarios de respuesta.
 */
export async function POST(request: NextRequest) {
  console.log('[API:tester] POST request received');
  
  try {
    // Validar el cuerpo de la solicitud
    console.log('[API:tester] Parsing request body');
    const body = await request.json();
    console.log('[API:tester] Request body parsed:', JSON.stringify(body).substring(0, 200) + '...');
    
    const validationResult = RequestSchema.safeParse(body);
    console.log('[API:tester] Validation result success:', validationResult.success);
    
    if (!validationResult.success) {
      console.log('[API:tester] Validation failed:', JSON.stringify(validationResult.error.format()));
      return NextResponse.json(
        { 
          error: 'Parámetros inválidos', 
          details: validationResult.error.format() 
        },
        { status: 400 }
      );
    }

    const params = validationResult.data;
    console.log('[API:tester] Validated params:', JSON.stringify(params));
    
    // Iniciar timestamp para tracking de tiempo
    const startTime = Date.now();
    console.log('[API:tester] Test started at:', new Date(startTime).toISOString());
    
    // Simular un retraso si se especifica
    if (params.delay > 0) {
      console.log(`[API:tester] Simulating delay of ${params.delay}ms`);
      await new Promise(resolve => setTimeout(resolve, params.delay));
    }
    
    // Simular un error si se solicita
    if (params.simulateError) {
      console.log(`[API:tester] Simulating error with code ${params.errorCode}`);
      return NextResponse.json(
        { 
          success: false,
          error: {
            code: params.errorCode,
            message: params.errorMessage || 'Error simulado para pruebas',
            requestId: generateRequestId()
          }
        },
        { status: params.errorCode }
      );
    }
    
    // Calcular tiempo de procesamiento
    const processingTime = Date.now() - startTime;
    console.log('[API:tester] Test completed in', processingTime, 'ms');
    
    // Preparar la respuesta según el tipo de prueba
    const response: TesterResponse = {
      success: params.testType !== 'error',
      testType: params.testType,
      timestamp: new Date().toISOString(),
      requestId: generateRequestId(),
      processingTime,
      metadata: {
        version: '1.0.0',
        environment: process.env.NODE_ENV || 'development'
      }
    };
    
    // Agregar información del proveedor de IA si se proporciona
    if (params.aiProvider) {
      response.aiProvider = params.aiProvider;
      response.aiModel = params.aiModel || 'default';
    }
    
    // Agregar datos personalizados si se proporcionan
    if (params.customData) {
      response.customData = params.customData;
    }
    
    // Agregar datos de ejemplo según el tamaño solicitado
    response.data = generateSampleData(params.responseSize);
    
    // Simular diferentes tipos de respuesta
    switch (params.testType) {
      case 'error':
        response.success = false;
        response.error = {
          code: 400,
          message: 'Error simulado para el tipo de prueba "error"'
        };
        break;
        
      case 'partial':
        response.data.partial = true;
        response.data.completionPercentage = 75;
        break;
        
      case 'timeout':
        // Ya hemos simulado el retraso, solo agregamos metadatos
        response.data.timeoutSimulated = true;
        break;
        
      default:
        // Respuesta de éxito (ya configurada)
        break;
    }
    
    console.log('[API:tester] Returning response with status 200');
    return NextResponse.json(response, { status: 200 });
    
  } catch (error: any) {
    console.error('[API:tester] Unexpected error:', error);
    
    return NextResponse.json(
      { 
        success: false,
        error: {
          code: 500,
          message: 'Error interno del servidor',
          details: error.message
        }
      },
      { status: 500 }
    );
  }
}

/**
 * GET /api/site/tester
 * 
 * Obtiene información sobre el servicio de API Tester.
 */
export async function GET(request: NextRequest) {
  console.log('[API:tester] GET request received');
  
  const serviceInfo = {
    service: "API Tester",
    version: "1.0.0",
    status: "operational",
    capabilities: [
      "response-simulation",
      "error-simulation",
      "delay-simulation",
      "custom-data-handling"
    ],
    supportedResponseTypes: ResponseTypes,
    supportedAiProviders: AiProviders
  };
  
  console.log('[API:tester] Returning service info with status 200');
  return NextResponse.json(serviceInfo, { status: 200 });
} 