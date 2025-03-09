import { NextRequest, NextResponse } from 'next/server'
import { analyzeSiteAction } from '@/lib/actions/analyze-site'
import { z } from 'zod'

/**
 * API BÁSICA DE ANÁLISIS DE SITIOS WEB
 * 
 * Esta es la implementación básica de la API de análisis de sitios web.
 * 
 * DIFERENCIAS CON LA API AVANZADA (/api/site/analyze):
 * 1. Esta API utiliza la función 'analyzeSiteAction' para realizar el análisis,
 *    mientras que la API avanzada utiliza servicios especializados.
 * 2. Esta API no permite configurar opciones avanzadas como tipo de análisis,
 *    profundidad, timeout, proveedor de IA, etc.
 * 3. Esta API devuelve una estructura de respuesta más simple.
 * 4. Esta API implementa un sistema de manejo de errores más básico.
 * 
 * NOTA: Esta API y la API avanzada (/api/site/analyze) son implementaciones
 * completamente independientes con diferentes enfoques y arquitecturas.
 * No comparten código entre ellas.
 * 
 * Para casos de uso más avanzados, se recomienda utilizar la API avanzada
 * /api/site/analyze.
 * 
 * Documentación completa: /docs/api/analysis/basic-analyze
 */

// Esquema para validar el cuerpo de la solicitud
const RequestSchema = z.object({
  url: z.string().url('Debe ser una URL válida'),
})

/**
 * Endpoint POST para analizar un sitio web
 * @param request Solicitud HTTP
 * @returns Respuesta con el análisis del sitio o un error
 */
export async function POST(request: NextRequest) {
  try {
    // Obtener la IP del cliente para rate limiting
    const ip = request.headers.get('x-forwarded-for') || 
               request.headers.get('x-real-ip') || 
               request.ip || 
               '0.0.0.0'
    
    // Obtener y validar el cuerpo de la solicitud
    const body = await request.json()
    
    try {
      const { url } = RequestSchema.parse(body)
      
      // Log de la solicitud
      console.log(`Analizando sitio: ${url} (IP: ${ip})`)
      
      // Llamar a la acción del servidor para analizar el sitio
      const result = await analyzeSiteAction({ url, ip })
      
      if (!result.success) {
        return NextResponse.json(
          { error: result.error || 'Error al analizar el sitio' },
          { status: 400 }
        )
      }
      
      // Devolver el resultado del análisis
      return NextResponse.json(result)
    } catch (validationError) {
      if (validationError instanceof z.ZodError) {
        return NextResponse.json(
          { error: validationError.errors[0].message },
          { status: 400 }
        )
      }
      throw validationError
    }
  } catch (error) {
    console.error('Error in analyze API route:', error)
    return NextResponse.json(
      { error: 'Error interno del servidor' },
      { status: 500 }
    )
  }
}

/**
 * Endpoint GET para proporcionar información sobre la API
 * @param request Solicitud HTTP
 * @returns Información sobre cómo usar la API
 */
export async function GET(request: NextRequest) {
  return NextResponse.json(
    { 
      message: 'Analizador de sitios web',
      usage: 'Envía una solicitud POST con un objeto JSON que contenga la URL a analizar: { "url": "https://ejemplo.com" }',
      endpoints: {
        '/api/analyze': 'POST - Analiza la estructura y contenido de un sitio web'
      },
      note: 'Esta es la API básica de análisis. Para opciones avanzadas, utiliza /api/site/analyze'
    },
    { status: 200 }
  )
} 