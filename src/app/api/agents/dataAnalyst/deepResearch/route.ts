import { NextResponse } from 'next/server';
import { DeepResearchService } from '@/lib/services/deep-research-service';
import { isValidUUID } from '@/lib/helpers/command-utils';

// Función para detectar URLs en el contexto
function detectURLsInContext(context: string): string[] {
  if (!context) return [];
  
  // Regex para detectar URLs (http, https, www, dominios)
  const urlRegex = /(?:https?:\/\/|www\.)[^\s<>"{}|\\^`[\]]+/gi;
  const matches = context.match(urlRegex) || [];
  
  // Limpiar y validar URLs
  const cleanUrls = matches
    .map(url => {
      // Limpiar caracteres finales comunes que no son parte de la URL
      return url.replace(/[.,;:)}\]]+$/, '');
    })
    .filter(url => {
      // Filtrar URLs que parecen válidas y relevantes
      return url.length > 5 && 
             !url.includes(' ') && 
             (url.startsWith('http') || url.startsWith('www.'));
    })
    // Eliminar duplicados
    .filter((url, index, arr) => arr.indexOf(url) === index);
  
  return cleanUrls;
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { site_id, research_topic, research_depth = 'comprehensive', context, deliverables } = body;
    
    // Validar parámetros requeridos
    if (!site_id) {
      return NextResponse.json(
        { success: false, error: { code: 'INVALID_REQUEST', message: 'site_id is required' } },
        { status: 400 }
      );
    }
    
    if (!isValidUUID(site_id)) {
      return NextResponse.json(
        { success: false, error: { code: 'INVALID_REQUEST', message: 'site_id must be a valid UUID' } },
        { status: 400 }
      );
    }
    
    if (!research_topic) {
      return NextResponse.json(
        { success: false, error: { code: 'INVALID_REQUEST', message: 'research_topic is required' } },
        { status: 400 }
      );
    }
    
    // Detectar URLs importantes en el contexto
    const detectedUrls = detectURLsInContext(context || '');
    console.log(`🔗 URLs detectadas en el contexto: ${detectedUrls.length}`, detectedUrls);
    
    // Procesar deliverables: convertir objeto a string o mantener string
    let processedDeliverables = deliverables;
    if (deliverables && typeof deliverables === 'object') {
      try {
        processedDeliverables = JSON.stringify(deliverables, null, 2);
      } catch (error) {
        console.warn('Error al serializar deliverables:', error);
        processedDeliverables = String(deliverables);
      }
    }

    // Agregar deliverables al contexto para búsquedas más específicas
    let enhancedContext = context || '';
    if (deliverables) {
      const deliverablesContext = typeof deliverables === 'object' 
        ? `\n\nRequiered deliverables:\n${JSON.stringify(deliverables, null, 2)}`
        : `\n\nRequiered deliverables:\n${deliverables}`;
      
      enhancedContext += deliverablesContext;
    }
    
    // NUEVA FUNCIONALIDAD: Agregar instrucciones para URLs detectadas
    if (detectedUrls.length > 0) {
      enhancedContext += '\n\n🔗 IMPORTANT URLs DETECTED IN CONTEXT:\n';
      detectedUrls.forEach((url, index) => {
        enhancedContext += `${index + 1}. ${url}\n`;
      });
      
      enhancedContext += `
MANDATORY INSTRUCTION: Since important URLs have been detected in the context, you MUST include at least one search operation specifically designed to gather comprehensive information about these URLs. This operation should:

1. Analyze the website content, structure, and purpose
2. Extract key information about the domain/organization
3. Identify important references, partnerships, or connections
4. Gather competitive intelligence if applicable
5. Extract contact information, business model, or relevant data
6. Analyze any products, services, or content offered

Create a specific search operation with queries like:
- "site analysis [URL] company information business model"
- "[domain name] company profile organization information"
- "website analysis [URL] content structure purpose"
- "[company/domain] competitors industry analysis"

This URL analysis operation is REQUIRED when URLs are detected in the context.`;
    }
    
    console.log(`🔧 Ejecutando investigación profunda para sitio: ${site_id}, topic: ${research_topic}`);
    
    // Usar el servicio simplificado
    const deepResearchService = DeepResearchService.getInstance();
    const result = await deepResearchService.executeDeepResearch(
      site_id,
      research_topic,
      research_depth,
      enhancedContext,
      processedDeliverables
    );
    
    // Retornar respuesta simplificada con estructura estándar como otras rutas de agentes
    return NextResponse.json({
      success: result.success,
      data: {
        command_id: result.commandId || null,
        status: result.status || 'completed',
        message: result.message || 'Research plan generated successfully',
        agent_id: result.agent_id || null,
        operations: result.operations || [],
        research_topic: result.researchTopic || research_topic,
        research_depth: research_depth,
        deliverables: processedDeliverables || null,
        detected_urls: detectedUrls.length > 0 ? detectedUrls : null,
        siteName: result.siteName,
        siteUrl: result.siteUrl,
        errors: result.errors,
        executionTime: result.executionTime,
        completedAt: result.completedAt
      }
    });
    
  } catch (error) {
    console.error('Error en ruta deepResearch:', error);
    return NextResponse.json(
      { 
        success: false, 
        error: { 
          code: 'SYSTEM_ERROR', 
          message: 'An internal system error occurred' 
        } 
      },
      { status: 500 }
    );
  }
}
