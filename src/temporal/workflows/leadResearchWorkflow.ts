// Workflow para investigación de leads específicos para un sitio
// Este workflow debe ser registrado y ejecutado por un Temporal Worker

export interface LeadResearchWorkflowArgs {
  site_id: string;
  lead_id: string;
}

export interface LeadResearchWorkflowResult {
  success: boolean;
  leadId: string;
  siteId: string;
  siteName?: string;
  siteUrl?: string;
  researchData: any;
  insights: Array<{
    category: string;
    insight: string;
    confidence_level: number;
    impact_level: 'high' | 'medium' | 'low';
  }>;
  recommendations: Array<{
    title: string;
    description: string;
    priority: 'high' | 'medium' | 'low';
    implementation_effort: 'low' | 'medium' | 'high';
  }>;
  deepResearchResult?: any;
  data?: any;
  errors?: string[];
  executionTime: string;
  completedAt: string;
}

/**
 * Workflow principal para investigación de leads
 * Este workflow coordina la investigación completa de un lead específico
 */
export async function leadResearchWorkflow(args: LeadResearchWorkflowArgs): Promise<LeadResearchWorkflowResult> {
  const startTime = Date.now();
  const errors: string[] = [];
  
  console.log(`🔍 Iniciando investigación de lead para sitio: ${args.site_id}`);
  console.log(`👤 Lead ID: ${args.lead_id}`);
  
  try {
    // Actividad 1: Obtener información básica del sitio y lead
    // const siteInfo = await getSiteInfoActivity(args.site_id);
    const siteInfo = {
      id: args.site_id,
      name: 'Uncodie',
      url: 'https://www.uncodie.com',
      industry: 'SaaS/Technology'
    };
    
    console.log(`🏢 Información del sitio obtenida: ${siteInfo.name} (${siteInfo.url})`);
    
    // Actividad 2: Ejecutar investigación del lead usando el agente sales
    let researchResult = null;
    
    try {
      // Hacer llamada HTTP al endpoint del agente sales
      console.log(`📞 Llamando al agente sales para investigación del lead`);
      
      const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001'}/api/agents/sales/leadResearch`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.SERVICE_API_KEY || ''
        },
        body: JSON.stringify({
          site_id: args.site_id,
          lead_id: args.lead_id,
          researchDepth: 'standard',
          includeSocialMedia: true,
          includeCompetitorAnalysis: true,
          includeFinancialInfo: false
        })
      });
      
      if (!response.ok) {
        const errorText = await response.text();
        const errorMessage = `API call failed: ${response.status} ${response.statusText}. ${errorText}`;
        console.error(`❌ Error en llamada al agente sales:`, errorMessage);
        errors.push(`Failed to execute lead research: ${errorMessage}`);
        researchResult = null;
      } else {
        researchResult = await response.json();
        console.log(`✅ Investigación del lead completada por el agente sales`);
      }
    } catch (apiError) {
      const errorMessage = `API call failed: ${apiError instanceof Error ? apiError.message : 'Unknown error'}`;
      console.error(`❌ Error ejecutando investigación del lead:`, errorMessage);
      errors.push(`Failed to execute lead research: ${errorMessage}`);
      researchResult = null;
    }
    
    // Actividad 3: Procesar resultados de la investigación
    let processedInsights: any[] = [];
    let processedRecommendations: any[] = [];
    
    if (researchResult && researchResult.success) {
      console.log(`🧠 Procesando resultados de investigación`);
      
      // Extraer insights de los resultados
      if (researchResult.data && researchResult.data.research_results) {
        const researchResults = researchResult.data.research_results;
        
        // Convertir resultados en insights estructurados
        researchResults.forEach((result: any, index: number) => {
          if (result.category === 'research') {
            processedInsights.push({
              category: result.title || `Research Insight ${index + 1}`,
              insight: result.content || 'No content available',
              confidence_level: 0.8,
              impact_level: 'medium' as const
            });
          } else if (result.category === 'recommendations') {
            processedRecommendations.push({
              title: result.title || `Recommendation ${index + 1}`,
              description: result.content || 'No description available',
              priority: 'medium' as const,
              implementation_effort: 'medium' as const
            });
          }
        });
      }
      
      console.log(`📊 Insights procesados: ${processedInsights.length}`);
      console.log(`💡 Recomendaciones procesadas: ${processedRecommendations.length}`);
    } else {
      console.log(`⚠️ No se pudieron obtener resultados válidos de la investigación`);
      
      // Agregar insights y recomendaciones de respaldo
      processedInsights = [
        {
          category: 'Research Status',
          insight: 'Lead research could not be completed due to API issues',
          confidence_level: 1.0,
          impact_level: 'high' as const
        }
      ];
      
      processedRecommendations = [
        {
          title: 'Retry Research',
          description: 'Attempt to re-run the lead research once API issues are resolved',
          priority: 'high' as const,
          implementation_effort: 'low' as const
        }
      ];
    }
    
    // Actividad 4: Investigación adicional profunda (opcional)
    let deepResearchResult = null;
    
    try {
      console.log(`🕵️ Ejecutando investigación profunda adicional con agente Data Analyst`);
      
      const deepResearchResponse = await fetch(`${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001'}/api/agents/dataAnalyst/deepResearch`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.SERVICE_API_KEY || ''
        },
        body: JSON.stringify({
          site_id: args.site_id,
          research_topic: `investigación profunda sobre prospecto: lead_id: ${args.lead_id} - análisis de mercado, competencia, oportunidades de negocio y estrategias de acercamiento`,
          research_depth: 'comprehensive'
        })
      });
      
      if (deepResearchResponse.ok) {
        const deepResearchData = await deepResearchResponse.json();
        if (deepResearchData.success && deepResearchData.data) {
          deepResearchResult = deepResearchData.data;
          console.log(`✅ Investigación profunda completada por agente Data Analyst`);
        }
      }
    } catch (deepResearchError) {
      const errorMessage = `Deep research failed: ${deepResearchError instanceof Error ? deepResearchError.message : 'Unknown error'}`;
      console.log(`⚠️ Investigación profunda falló:`, errorMessage);
      errors.push(errorMessage);
    }
    
    const endTime = Date.now();
    const executionTime = `${((endTime - startTime) / 1000).toFixed(2)}s`;
    
    console.log(`✅ Investigación de lead completada para sitio ${args.site_id}`);
    console.log(`👤 Lead: ${args.lead_id}`);
    console.log(`📊 Insights: ${processedInsights.length}`);
    console.log(`💡 Recomendaciones: ${processedRecommendations.length}`);
    console.log(`⏱️ Tiempo de ejecución: ${executionTime}`);
    
    return {
      success: errors.length === 0 && researchResult?.success,
      leadId: args.lead_id,
      siteId: args.site_id,
      siteName: siteInfo.name,
      siteUrl: siteInfo.url,
      researchData: researchResult?.data || null,
      insights: processedInsights,
      recommendations: processedRecommendations,
      deepResearchResult,
      data: researchResult?.data || null,
      errors: errors.length > 0 ? errors : undefined,
      executionTime,
      completedAt: new Date().toISOString()
    };
    
  } catch (error) {
    const endTime = Date.now();
    const executionTime = `${((endTime - startTime) / 1000).toFixed(2)}s`;
    
    console.error(`❌ Error en la investigación de lead para sitio ${args.site_id}:`, error);
    
    return {
      success: false,
      leadId: args.lead_id,
      siteId: args.site_id,
      siteName: 'Unknown',
      siteUrl: '',
      researchData: null,
      insights: [],
      recommendations: [],
      deepResearchResult: null,
      data: null,
      errors: [
        error instanceof Error ? error.message : 'Error desconocido durante la investigación de lead',
        ...errors
      ],
      executionTime,
      completedAt: new Date().toISOString()
    };
  }
}

/**
 * Workflow especializado para investigación de leads de alta prioridad
 */
export async function priorityLeadResearchWorkflow(args: {
  site_id: string;
  lead_id: string;
  priority_level: 'high' | 'urgent';
  research_areas?: string[];
}): Promise<LeadResearchWorkflowResult> {
  console.log(`🚨 Iniciando investigación prioritaria de lead`);
  console.log(`📈 Nivel de prioridad: ${args.priority_level}`);
  console.log(`🎯 Áreas específicas: ${args.research_areas?.join(', ') || 'Todas'}`);
  
  // Personalizar el workflow base según la prioridad
  const baseArgs: LeadResearchWorkflowArgs = {
    site_id: args.site_id,
    lead_id: args.lead_id
  };
  
  return await leadResearchWorkflow(baseArgs);
} 