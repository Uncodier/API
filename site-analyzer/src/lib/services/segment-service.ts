/**
 * Implementación del servicio de segmentos de usuario
 * 
 * Este servicio permite obtener segmentos de usuario, ya sea desde datos simulados
 * o generados mediante análisis real con la API de conversación.
 */

import { analyzeWithConversationApi } from './conversation-client';

/**
 * Interfaz para los segmentos en la base de datos
 */
export interface DbSegment {
  id: string;
  name: string;
  description: string | null;
  audience: string | null;
  size: number | null;
  estimated_value?: number | null;
  engagement: number | null;
  is_active: boolean | null;
  analysis: any[] | null;
  topics: any[] | null;
  site_id: string;
  user_id: string;
  created_at: string;
  updated_at: string;
  language: string;
  url: string | null;
  profitability_score?: number;
  campaigns?: number;
  // Indicador de si el segmento fue generado mediante análisis real
  is_ai_generated?: boolean;
  _raw_response?: any;
}

/**
 * Obtiene los segmentos de un usuario, ya sea desde la base de datos o
 * mediante análisis con la API de conversación, dependiendo de los parámetros.
 * 
 * @param userId ID del usuario (opcional, para CRUD de segmentos)
 * @param siteUrl URL del sitio a analizar (requerido para análisis real)
 * @param segmentCount Número de segmentos a crear (1-20, por defecto 5)
 * @param debugMode Si es true, imprime información adicional de depuración
 * @returns Array de segmentos del usuario
 * @throws Error si hay un problema con la API de conversación
 */
export async function getUserSegments(
  userId?: string, 
  siteUrl?: string, 
  segmentCount: number = 5,
  debugMode: boolean = false
): Promise<DbSegment[]> {
  try {
    // Si se proporciona una URL, realizar análisis real
    if (siteUrl) {
      console.log(`[Segment Service] Iniciando análisis real para: ${siteUrl}, Segmentos a crear: ${segmentCount}`);
      
      // Validar la URL antes de continuar
      if (!isValidUrl(siteUrl)) {
        throw new Error(`URL inválida: ${siteUrl}`);
      }
      
      // Validar el número de segmentos
      if (segmentCount < 1 || segmentCount > 20) {
        throw new Error(`Número de segmentos inválido: ${segmentCount}. Debe estar entre 1 y 20.`);
      }
      
      // Registrar inicio del análisis con timestamp para medir duración
      const startTime = Date.now();
      console.log(`[Segment Service] Análisis iniciado a las ${new Date(startTime).toISOString()}`);
      
      // Prompt para solicitar segmentos
      const prompt = `Analiza el sitio web ${siteUrl} y genera ${segmentCount} segmentos de audiencia rentables basados en el contenido y diseño del sitio. Asegúrate de incluir detalles completos para cada segmento. IMPORTANTE: Este es un análisis real, NO devuelvas ejemplos genéricos.`;
      
      // Llamar a la API de conversación para obtener segmentos reales
      const result = await analyzeWithConversationApi(
        prompt,
        'anthropic', // Usar Claude (puedes cambiarlo a 'openai' o 'gemini')
        'claude-3-5-sonnet-20240620', // Modelo específico
        siteUrl,
        true, // Incluir screenshot
        60000, // Timeout de 60 segundos
        debugMode // Modo de depuración
      );
      
      // Registrar fin del análisis y calcular duración
      const endTime = Date.now();
      const duration = (endTime - startTime) / 1000; // en segundos
      console.log(`[Segment Service] Análisis completado en ${duration.toFixed(2)} segundos`);
      
      // Verificar si tenemos segmentos en la respuesta
      if (!result) {
        throw new Error('La API de conversación no devolvió ningún resultado');
      }
      
      if (!result.segments || !Array.isArray(result.segments)) {
        console.warn('[Segment Service] La respuesta no contiene un array de segmentos:', result);
        throw new Error('La respuesta de la API no contiene segmentos válidos');
      }
      
      console.log(`[Segment Service] Segmentos obtenidos: ${result.segments.length}`);
      
      // Limitar el número de segmentos al solicitado
      const limitedSegments = result.segments.slice(0, segmentCount);
      
      // Convertir los segmentos del formato de respuesta al formato DbSegment
      return limitedSegments.map((segment: any, index: number) => ({
        id: segment.id || `db_seg_${Date.now()}_${index}`,
        name: segment.name || 'Segmento sin nombre',
        description: segment.description || null,
        audience: segment.targetAudience || null,
        size: segment.estimatedSize ? parseNumericValue(segment.estimatedSize) : null,
        estimated_value: segment.estimatedValue ? parseNumericValue(segment.estimatedValue) : null,
        engagement: segment.confidenceScore ? Math.round(segment.confidenceScore * 100) : null,
        is_active: true,
        analysis: segment.attributes?.analysis || [],
        topics: segment.attributes?.topics || [],
        site_id: `site_${Date.now()}`,
        user_id: userId || 'system_m2m_user',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        language: segment.language || 'es',
        url: siteUrl,
        profitability_score: segment.profitabilityScore || 0.75,
        campaigns: 0,
        is_ai_generated: true,
        _raw_response: debugMode ? result : undefined
      }));
    } else {
      // Modo simulado (para pruebas o cuando no se proporciona URL)
      console.log(`[Segment Service] Usando modo simulado. UserId: ${userId || 'no proporcionado'}`);
      
      // Simular un tiempo de procesamiento para que no sea instantáneo
      await new Promise(resolve => setTimeout(resolve, 500));
      
      // Datos de ejemplo para la respuesta
      const exampleSegments: DbSegment[] = [
        {
          id: "db_seg_123456",
          name: "Creadores de Contenido Digital",
          description: "Profesionales y aficionados de 20-40 años dedicados a la creación de contenido digital para redes sociales y plataformas online",
          audience: "media_entertainment",
          size: 15,
          estimated_value: 150000,
          engagement: 85,
          is_active: true,
          analysis: ["contenido digital", "creadores", "redes sociales"],
          topics: ["monetización", "herramientas creativas", "workflow"],
          site_id: "site_123",
          user_id: userId || 'system_m2m_user',
          created_at: "2023-06-15T14:30:00Z",
          updated_at: "2023-06-15T14:30:00Z",
          language: "es",
          url: siteUrl || "https://ejemplo.com",
          profitability_score: 0.88,
          campaigns: 3,
          is_ai_generated: false
        },
        {
          id: "db_seg_789012",
          name: "Compradores de lujo en móvil",
          description: "Profesionales urbanos de 30-50 años con alto poder adquisitivo que prefieren comprar desde dispositivos móviles",
          audience: "retail",
          size: 8,
          estimated_value: 250000,
          engagement: 92,
          is_active: true,
          analysis: ["lujo", "móvil", "compras"],
          topics: ["experiencia móvil", "exclusividad", "personalización"],
          site_id: "site_123",
          user_id: userId || 'system_m2m_user',
          created_at: "2023-07-20T10:15:00Z",
          updated_at: "2023-07-20T10:15:00Z",
          language: "es-ES",
          url: siteUrl || "https://ejemplo.com",
          profitability_score: 0.92,
          campaigns: 2,
          is_ai_generated: false
        },
        {
          id: "db_seg_345678",
          name: "Entusiastas de la tecnología",
          description: "Profesionales de 25-45 años con alto interés en tecnología y gadgets",
          audience: "technology",
          size: 20,
          estimated_value: 180000,
          engagement: 78,
          is_active: true,
          analysis: ["tecnología", "gadgets", "innovación"],
          topics: ["IA", "realidad virtual", "dispositivos inteligentes"],
          site_id: "site_123",
          user_id: userId || 'system_m2m_user',
          created_at: "2023-05-10T09:45:00Z",
          updated_at: "2023-05-10T09:45:00Z",
          language: "es",
          url: siteUrl || "https://ejemplo.com",
          profitability_score: 0.85,
          campaigns: 5,
          is_ai_generated: false
        }
      ];
      
      // Limitar el número de segmentos al solicitado
      return exampleSegments.slice(0, segmentCount);
    }
  } catch (error: any) {
    console.error('[Segment Service] Error al obtener segmentos:', error);
    
    // Añadir información adicional al error
    const enhancedError = new Error(
      `Error al obtener segmentos: ${error.message || 'Error desconocido'}`
    );
    
    // Añadir propiedades adicionales al error
    (enhancedError as any).originalError = error;
    (enhancedError as any).userId = userId;
    (enhancedError as any).siteUrl = siteUrl;
    (enhancedError as any).segmentCount = segmentCount;
    (enhancedError as any).code = 'SEGMENT_SERVICE_ERROR';
    
    throw enhancedError;
  }
}

/**
 * Valida si una cadena es una URL válida
 * 
 * @param url La URL a validar
 * @returns true si es una URL válida, false en caso contrario
 */
function isValidUrl(url: string): boolean {
  try {
    const parsedUrl = new URL(url);
    // Verificar que el protocolo sea http o https
    return parsedUrl.protocol === 'http:' || parsedUrl.protocol === 'https:';
  } catch (error) {
    return false;
  }
}

/**
 * Obtiene un segmento específico por su ID
 * 
 * @param segmentId ID del segmento
 * @returns El segmento o null si no existe
 */
export async function getSegmentById(segmentId: string): Promise<DbSegment | null> {
  // Simular un tiempo de procesamiento
  await new Promise(resolve => setTimeout(resolve, 200));
  
  // Datos de ejemplo para la respuesta
  const exampleSegments: DbSegment[] = [
    {
      id: "db_seg_123456",
      name: "Creadores de Contenido Digital",
      description: "Profesionales y aficionados de 20-40 años dedicados a la creación de contenido digital para redes sociales y plataformas online",
      audience: "media_entertainment",
      size: 15,
      estimated_value: 150000,
      engagement: 85,
      is_active: true,
      analysis: ["contenido digital", "creadores", "redes sociales"],
      topics: ["monetización", "herramientas creativas", "workflow"],
      site_id: "site_123",
      user_id: "system_m2m_user",
      created_at: "2023-06-15T14:30:00Z",
      updated_at: "2023-06-15T14:30:00Z",
      language: "es",
      url: "https://ejemplo.com",
      profitability_score: 0.88,
      campaigns: 3
    },
    {
      id: "db_seg_789012",
      name: "Compradores de lujo en móvil",
      description: "Profesionales urbanos de 30-50 años con alto poder adquisitivo que prefieren comprar desde dispositivos móviles",
      audience: "retail",
      size: 8,
      estimated_value: 250000,
      engagement: 92,
      is_active: true,
      analysis: ["lujo", "móvil", "compras"],
      topics: ["experiencia móvil", "exclusividad", "personalización"],
      site_id: "site_123",
      user_id: "system_m2m_user",
      created_at: "2023-07-20T10:15:00Z",
      updated_at: "2023-07-20T10:15:00Z",
      language: "es-ES",
      url: "https://ejemplo.com",
      profitability_score: 0.92,
      campaigns: 2
    }
  ];
  
  const segment = exampleSegments.find(s => s.id === segmentId);
  return segment || null;
}

/**
 * Elimina un segmento de la base de datos (simulado)
 * 
 * @param segmentId ID del segmento a eliminar
 * @param userId ID del usuario (para verificar propiedad)
 * @returns true si se eliminó correctamente
 */
export async function deleteSegment(segmentId: string, userId: string): Promise<boolean> {
  // Simular un tiempo de procesamiento
  await new Promise(resolve => setTimeout(resolve, 300));
  
  // Simular éxito
  return true;
}

/**
 * Actualiza un segmento existente (simulado)
 * 
 * @param segmentId ID del segmento a actualizar
 * @param userId ID del usuario
 * @param updates Campos a actualizar
 * @returns El segmento actualizado o null si hubo un error
 */
export async function updateUserSegment(
  segmentId: string, 
  userId: string,
  updates: Partial<Omit<DbSegment, 'id' | 'user_id' | 'created_at' | 'updated_at'>>
): Promise<DbSegment | null> {
  // Simular un tiempo de procesamiento
  await new Promise(resolve => setTimeout(resolve, 300));
  
  // Obtener el segmento
  const segment = await getSegmentById(segmentId);
  
  if (!segment) {
    return null;
  }
  
  // Simular actualización
  const updatedSegment: DbSegment = {
    ...segment,
    ...updates,
    updated_at: new Date().toISOString()
  };
  
  return updatedSegment;
}

/**
 * Convierte un valor de string a número, eliminando caracteres no numéricos
 * como comas, espacios, símbolos de moneda, etc.
 * 
 * @param value Valor a convertir
 * @returns Valor numérico o 0 si no se puede convertir
 */
function parseNumericValue(value: any): number {
  if (typeof value === 'number') {
    return value;
  }
  
  if (!value || typeof value !== 'string') {
    return 0;
  }
  
  // Eliminar caracteres no numéricos excepto puntos decimales
  // Esto elimina comas, símbolos de moneda, espacios, etc.
  const cleanedValue = value.replace(/[^0-9.]/g, '');
  
  // Convertir a número
  const numericValue = parseFloat(cleanedValue);
  
  // Devolver el valor numérico o 0 si no es un número válido
  return isNaN(numericValue) ? 0 : numericValue;
} 