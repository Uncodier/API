import { NextRequest, NextResponse } from 'next/server';
import { EmailSignatureService } from '@/lib/services/email/EmailSignatureService';

/**
 * Endpoint para generar firmas para agentes
 * 
 * @param request Solicitud entrante con los parámetros para generar la firma
 * @returns Respuesta con la firma generada
 * 
 * Parámetros de la solicitud:
 * - site_id: (Requerido) ID del sitio para obtener configuración
 * - agent_name: (Opcional) Nombre del agente para personalizar la firma
 * - format: (Opcional) Formato de respuesta: 'both' (default), 'plain', 'formatted'
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    
    // Extraer parámetros de la solicitud
    const { site_id, agent_name, format = 'both' } = body;
    
    // Validar parámetro requerido
    if (!site_id) {
      return NextResponse.json(
        { 
          success: false, 
          error: { 
            code: 'INVALID_REQUEST', 
            message: 'site_id is required' 
          } 
        },
        { status: 400 }
      );
    }

    // Validar formato
    const validFormats = ['both', 'plain', 'formatted'];
    if (!validFormats.includes(format)) {
      return NextResponse.json(
        { 
          success: false, 
          error: { 
            code: 'INVALID_REQUEST', 
            message: 'format must be one of: both, plain, formatted' 
          } 
        },
        { status: 400 }
      );
    }
    
    // Generar la firma
    const signature = await EmailSignatureService.generateAgentSignature(site_id, agent_name);
    
    // Preparar respuesta según el formato solicitado
    let responseData: any = {
      success: true,
      site_id,
      agent_name: agent_name || null,
      generated_at: new Date().toISOString()
    };

    switch (format) {
      case 'plain':
        responseData.signature = signature.plainText;
        break;
      case 'formatted':
        responseData.signature = signature.formatted;
        break;
      case 'both':
      default:
        responseData.signatures = {
          plain: signature.plainText,
          formatted: signature.formatted
        };
        break;
    }

    return NextResponse.json(responseData, { status: 200 });
    
  } catch (error) {
    console.error('Error en endpoint signature:', error);
    
    return NextResponse.json(
      { 
        success: false, 
        error: { 
          code: 'INTERNAL_SERVER_ERROR', 
          message: 'An internal server error occurred while generating the signature' 
        } 
      },
      { status: 500 }
    );
  }
}

/**
 * Endpoint GET para obtener información sobre el servicio de firmas
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const siteId = searchParams.get('site_id');
    const preview = searchParams.get('preview') === 'true';
    
    if (preview && siteId) {
      // Generar una previsualización de la firma
      const signature = await EmailSignatureService.generateAgentSignature(siteId, 'Agente de Ejemplo');
      
      return NextResponse.json({
        success: true,
        site_id: siteId,
        preview: true,
        signatures: {
          plain: signature.plainText,
          formatted: signature.formatted
        },
        generated_at: new Date().toISOString()
      });
    }
    
    // Información sobre el servicio
    return NextResponse.json({
      success: true,
      service: 'Email Signature Generator',
      description: 'Generates professional email signatures for agents based on site configuration',
      endpoints: {
        POST: {
          description: 'Generate a signature for an agent',
          required_params: ['site_id'],
          optional_params: ['agent_name', 'format'],
          formats: ['both', 'plain', 'formatted']
        },
        GET: {
          description: 'Get service information or preview signature',
          optional_params: ['site_id', 'preview']
        }
      },
      usage_examples: {
        generate_signature: {
          method: 'POST',
          body: {
            site_id: 'your-site-id',
            agent_name: 'María González',
            format: 'both'
          }
        },
        preview_signature: {
          method: 'GET',
          url: '/api/agents/tools/signature?site_id=your-site-id&preview=true'
        }
      }
    });
    
  } catch (error) {
    console.error('Error en consulta de signature:', error);
    
    return NextResponse.json(
      { 
        success: false, 
        error: { 
          code: 'INTERNAL_SERVER_ERROR', 
          message: 'An internal server error occurred while retrieving signature information' 
        } 
      },
      { status: 500 }
    );
  }
} 