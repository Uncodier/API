import { NextResponse } from 'next/server';
import { DeepResearchService } from '@/lib/services/deep-research-service';
import { isValidUUID } from '@/lib/helpers/command-utils';

// Función para detectar URLs en un texto
function extractUrls(text: string): string[] {
  if (!text) return [];
  
  // Regex para detectar URLs (http/https, www, o dominios)
  const urlRegex = /(?:https?:\/\/)?(?:www\.)?(?:[a-zA-Z0-9-]+\.)+[a-zA-Z]{2,}(?:\/[^\s]*)?/g;
  const matches = text.match(urlRegex) || [];
  
  // Filtrar y limpiar URLs
  return matches
    .map(url => {
      // Añadir https:// si no tiene protocolo
      if (!url.startsWith('http://') && !url.startsWith('https://')) {
        return `https://${url}`;
      }
      return url;
    })
    .filter((url, index, self) => self.indexOf(url) === index); // Eliminar duplicados
}

export async function POST(request: Request) {
  try {
    console.log('🚀 [deepResearch] Iniciando procesamiento de request');
    
    const body = await request.json();
    console.log('📋 [deepResearch] Body recibido:', JSON.stringify(body, null, 2));
    
    const { site_id, research_topic, research_depth = 'comprehensive', context, deliverables } = body;
    
    // Validar parámetros requeridos
    if (!site_id) {
      console.log('❌ [deepResearch] Error: site_id faltante');
      return NextResponse.json(
        { success: false, error: { code: 'INVALID_REQUEST', message: 'site_id is required' } },
        { status: 400 }
      );
    }
    
    if (!isValidUUID(site_id)) {
      console.log('❌ [deepResearch] Error: site_id no es un UUID válido:', site_id);
      return NextResponse.json(
        { success: false, error: { code: 'INVALID_REQUEST', message: 'site_id must be a valid UUID' } },
        { status: 400 }
      );
    }
    
    if (!research_topic) {
      console.log('❌ [deepResearch] Error: research_topic faltante');
      return NextResponse.json(
        { success: false, error: { code: 'INVALID_REQUEST', message: 'research_topic is required' } },
        { status: 400 }
      );
    }

    // El research_topic puede ser largo, no hay límite en el input
    
    console.log('✅ [deepResearch] Validaciones iniciales pasadas');
    console.log('📝 [deepResearch] Parámetros:', { site_id, research_topic: research_topic.substring(0, 100) + '...', research_depth });
    
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

    // Detectar URLs en research_topic y context
    const topicUrls = extractUrls(research_topic);
    const contextUrls = extractUrls(context || '');
    const deliverablesUrls = extractUrls(typeof deliverables === 'string' ? deliverables : JSON.stringify(deliverables || ''));
    
    // Combinar todas las URLs encontradas
    const allUrls = [...topicUrls, ...contextUrls, ...deliverablesUrls]
      .filter((url, index, self) => self.indexOf(url) === index); // Eliminar duplicados

    console.log(`🔗 URLs detectadas en la investigación: ${allUrls.length > 0 ? allUrls.join(', ') : 'ninguna'}`);

    // Agregar deliverables al contexto para búsquedas más específicas
    let enhancedContext = context || '';
    if (deliverables) {
      const deliverablesContext = typeof deliverables === 'object' 
        ? `\n\nRequiered deliverables:\n${JSON.stringify(deliverables, null, 2)}`
        : `\n\nRequiered deliverables:\n${deliverables}`;
      
      enhancedContext += deliverablesContext;
    }

    // Añadir instrucción específica sobre URLs si se detectaron
    if (allUrls.length > 0) {
      enhancedContext += `\n\nIMPORTANT URLs DETECTED: ${allUrls.join(', ')}`;
      enhancedContext += `\n\nURL RESEARCH INSTRUCTION: For each URL that is IMPORTANT and RELEVANT to achieving the research objectives, you should include at least one specific search operation to gather comprehensive information about that URL/website/domain. Only include URL research operations if the URL contains critical information for the research topic. This should include:
- Website content analysis and key information
- Company/organization details if it's a business website
- Recent news or updates related to the domain
- Technical specifications or service details
- Contact information and business model
- Any relevant data that supports the research topic

Evaluate each URL's importance to the research goals before creating dedicated search operations.`;
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
    
    // Si el servicio devuelve un error específico sobre el agente, devolver 404
    if (!result.success && result.message && result.message.includes('No se encontró un agente con role "Data Analyst"')) {
      return NextResponse.json(
        { 
          success: false, 
          error: { 
            code: 'DATA_ANALYST_NOT_FOUND', 
            message: result.message 
          } 
        },
        { status: 404 }
      );
    }
    
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
        siteName: result.siteName,
        siteUrl: result.siteUrl,
        errors: result.errors,
        executionTime: result.executionTime,
        completedAt: result.completedAt
      }
    });
    
  } catch (error) {
    console.error('❌ [deepResearch] Error en ruta deepResearch:', error);
    
    // Si es un error de parsing JSON, devolver 400
    if (error instanceof SyntaxError && error.message.includes('JSON')) {
      console.error('❌ [deepResearch] Error de parsing JSON:', error.message);
      return NextResponse.json(
        { 
          success: false, 
          error: { 
            code: 'INVALID_JSON', 
            message: 'Invalid JSON in request body' 
          } 
        },
        { status: 400 }
      );
    }
    
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
