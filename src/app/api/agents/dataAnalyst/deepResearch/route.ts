import { NextResponse } from 'next/server';
import { DeepResearchService } from '@/lib/services/deep-research-service';
import { isValidUUID } from '@/lib/helpers/command-utils';

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
