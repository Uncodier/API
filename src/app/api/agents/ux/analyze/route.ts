import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { performStructuredAnalysis } from '@/lib/services/structured-analyzer-service'
import { createSiteAnalysis } from '@/lib/database/site-analysis-db'
import { DataFetcher } from '@/lib/agentbase/services/agent/BackgroundServices/DataFetcher'
import { DatabaseAdapter } from '@/lib/agentbase/adapters/DatabaseAdapter'
import { getSiteHtml } from '@/lib/actions/analyze-site'

/**
 * API DE ANÁLISIS UX Y BRANDING
 * 
 * Este endpoint realiza un análisis específico de UX y branding para completar
 * el objeto settings.branding y generar recomendaciones, problemas y oportunidades
 * de experiencia de usuario.
 * 
 * Funcionalidades:
 * - Análisis estructurado del sitio web
 * - Completado automático del objeto settings.branding
 * - Generación de recomendaciones UX
 * - Identificación de problemas y oportunidades
 * - Guardado del análisis en la base de datos
 */

// Esquema de validación para los parámetros de entrada
const RequestSchema = z.object({
  site_id: z.string().uuid('site_id debe ser un UUID válido'),
  user_id: z.string().uuid('user_id debe ser un UUID válido').optional(),
  options: z.object({
    timeout: z.number().min(5000).max(120000).default(60000),
    includeScreenshot: z.boolean().default(true),
    provider: z.enum(['anthropic', 'openai', 'gemini']).default('openai'),
    modelId: z.string().default('gpt-4.1'),
    updateBranding: z.boolean().default(false),
    language: z.enum(['es', 'en']).default('es')
  }).optional(),
  deliverables: z.object({
    branding_analysis: z.boolean().default(true),
    ux_assessment: z.boolean().default(true),
    recommendations: z.boolean().default(true),
    problems: z.boolean().default(true),
    opportunities: z.boolean().default(true),
    competitive_analysis: z.boolean().default(false),
    accessibility_audit: z.boolean().default(false),
    performance_metrics: z.boolean().default(false)
  }).optional()
})

// Interfaces para la respuesta
interface UXAnalysisResponse {
  success: boolean
  data?: {
    site_info: {
      site: any
      settings: any
    }
    branding: {
      brand_pyramid: {
        brand_essence: string
        brand_personality: string
        brand_benefits: string
        brand_attributes: string
        brand_values: string
        brand_promise: string
      }
      brand_archetype: string
      color_palette: {
        primary_color: string
        secondary_color: string
        accent_color: string
        neutral_colors: string[]
      }
      typography: {
        primary_font: string
        secondary_font: string
        font_hierarchy: string
        font_sizes: string
      }
      voice_and_tone: {
        brand_voice: string
        communication_style: string
        personality_traits: string[]
        do_and_dont: {
          do: string[]
          dont: string[]
        }
      }
      brand_guidelines: {
        logo_usage: string
        color_usage: string
        typography_usage: string
        imagery_style: string
        messaging_guidelines: string
      }
      brand_assets: {
        logo_variations: string[]
        color_swatches: string[]
        font_files: string[]
        templates: string[]
      }
    }
    ux_assessment: {
      overall_score: number
      usability_score: number
      accessibility_score: number
      visual_design_score: number
      performance_score: number
      branding_consistency_score: number
      user_experience_details: {
        navigation_clarity: number
        content_organization: number
        visual_hierarchy: number
        responsive_design: number
        load_time: number
        error_handling: number
      }
    }
    recommendations: Array<{
      category: string
      priority: 'alta' | 'media' | 'baja'
      effort: 'alto' | 'medio' | 'bajo'
      title: string
      description: string
      impact: string
      implementation_steps: string[]
    }>
    problems: Array<{
      category: string
      severity: 'crítico' | 'alto' | 'medio' | 'bajo'
      title: string
      description: string
      user_impact: string
      business_impact: string
      suggested_solutions: string[]
    }>
    opportunities: Array<{
      category: string
      potential: 'alto' | 'medio' | 'bajo'
      complexity: 'alta' | 'media' | 'baja'
      title: string
      description: string
      expected_outcomes: string[]
      implementation_timeline: string
    }>
    analysis_id: string
  }
  error?: {
    message: string
    type: string
    details?: any
  }
}

export async function POST(request: NextRequest) {
  try {
    const requestBody = await request.json()
    const { site_id, user_id, options, deliverables } = RequestSchema.parse(requestBody)

    console.log(`🎨 [UX Analysis] Iniciando análisis UX para sitio: ${site_id}`)
    console.log(`🎯 [UX Analysis] Deliverables solicitados:`, deliverables)

    // Obtener información del sitio desde la base de datos
    const siteInfo = await DataFetcher.getSiteInfo(site_id)
    
    if (!siteInfo.site) {
      return NextResponse.json({
        success: false,
        error: {
          message: 'No se encontró el sitio especificado',
          type: 'SITE_NOT_FOUND'
        }
      }, { status: 404 })
    }

    if (!siteInfo.site.url) {
      return NextResponse.json({
        success: false,
        error: {
          message: 'El sitio no tiene una URL configurada',
          type: 'SITE_URL_MISSING'
        }
      }, { status: 400 })
    }

    // Usar el user_id del sitio si no se proporciona
    const effectiveUserId = user_id || siteInfo.site.user_id

    if (!effectiveUserId) {
      return NextResponse.json({
        success: false,
        error: {
          message: 'No se pudo determinar el user_id para el análisis',
          type: 'USER_ID_MISSING'
        }
      }, { status: 400 })
    }

    const analysisOptions = {
      timeout: options?.timeout || 60000,
      includeScreenshot: options?.includeScreenshot !== false,
      provider: options?.provider || 'openai',
      modelId: options?.modelId || 'gpt-4.1'
    }

    const startTime = Date.now()
    
    console.log(`🔍 [UX Analysis] Analizando sitio: ${siteInfo.site.url}`)

    // Extraer HTML y screenshot del sitio web
    console.log(`🌐 [UX Analysis] Extrayendo HTML y screenshot del sitio...`)
    let htmlContent = '';
    let screenshot = '';
    
    try {
      const siteData = await getSiteHtml(siteInfo.site.url, {
        timeout: analysisOptions.timeout,
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36'
      });
      
      htmlContent = siteData.html;
      screenshot = siteData.screenshot;
      
      console.log(`✅ [UX Analysis] HTML extraído: ${htmlContent.length} bytes`);
      console.log(`✅ [UX Analysis] Screenshot extraído: ${screenshot ? 'Sí' : 'No'}`);
    } catch (htmlError) {
      console.error(`❌ [UX Analysis] Error extrayendo HTML: ${htmlError}`);
      throw new Error(`Error extrayendo contenido del sitio: ${htmlError}`);
    }

    // Preparar deliverables por defecto (siempre genera branding_analysis)
    const defaultDeliverables = {
      branding_analysis: true,  // SIEMPRE generar branding, independientemente de si se guarda
      ux_assessment: true,
      recommendations: true,
      problems: true,
      opportunities: true,
      competitive_analysis: false,
      accessibility_audit: false,
      performance_metrics: false
    }

    // Combinar deliverables del request con los defaults
    const finalDeliverables = {
      ...defaultDeliverables,
      ...deliverables
    }

    console.log(`🎯 [UX Analysis] Deliverables finales a enviar a GPT-4.1:`, finalDeliverables)

    // Realizar análisis estructurado del sitio con HTML y screenshot
    const structuredAnalysis = await performStructuredAnalysis(siteInfo.site.url, {
      ...analysisOptions,
      htmlContent,
      screenshot,
      deliverables: finalDeliverables
    })

    if (!structuredAnalysis) {
      throw new Error('Error en análisis estructurado: No se pudo obtener resultado del análisis')
    }

    // Debugging: Ver qué deliverables se generaron realmente
    console.log(`🔍 [UX Analysis] Deliverables generados por GPT-4.1:`)
    console.log(`   - branding_analysis: ${structuredAnalysis.branding_analysis ? 'SÍ' : 'NO'}`)
    console.log(`   - ux_assessment: ${structuredAnalysis.ux_assessment ? 'SÍ' : 'NO'}`)
    console.log(`   - recommendations: ${structuredAnalysis.recommendations ? 'SÍ' : 'NO'}`)
    console.log(`   - problems: ${structuredAnalysis.problems ? 'SÍ' : 'NO'}`)
    console.log(`   - opportunities: ${structuredAnalysis.opportunities ? 'SÍ' : 'NO'}`)

    const endTime = Date.now()
    const processingTime = endTime - startTime

    console.log(`⚡ [UX Analysis] Análisis completado en ${processingTime}ms`)

    // Extraer deliverables del análisis estructurado
    const responseData: any = {
      site_info: siteInfo,
      analysis_id: '' // Se asignará después de guardar
    }

    // Procesar deliverables solicitados
    const requestedDeliverables = finalDeliverables

    // Extraer branding del análisis estructurado si se solicitó
    if (requestedDeliverables.branding_analysis) {
      console.log(`🎨 [UX Analysis] Procesando branding_analysis desde análisis estructurado`)
      responseData.branding = structuredAnalysis.branding_analysis || 
        await extractBrandingFromAnalysis(structuredAnalysis, siteInfo, options?.language || 'es')
    }

    // Procesar UX assessment si se solicitó
    if (requestedDeliverables.ux_assessment) {
      console.log(`📊 [UX Analysis] Procesando ux_assessment desde análisis estructurado`)
      responseData.ux_assessment = structuredAnalysis.ux_assessment || 
        await performUXAssessment(structuredAnalysis, siteInfo, options?.language || 'es')
    }

    // Procesar recomendaciones si se solicitaron
    if (requestedDeliverables.recommendations) {
      console.log(`💡 [UX Analysis] Procesando recommendations desde análisis estructurado`)
      responseData.recommendations = structuredAnalysis.recommendations || 
        await generateRecommendations(structuredAnalysis, responseData.ux_assessment, siteInfo, options?.language || 'es')
    }

    // Procesar problemas si se solicitaron
    if (requestedDeliverables.problems) {
      console.log(`🚨 [UX Analysis] Procesando problems desde análisis estructurado`)
      responseData.problems = structuredAnalysis.problems || 
        await identifyProblems(structuredAnalysis, responseData.ux_assessment, siteInfo, options?.language || 'es')
    }

    // Procesar oportunidades si se solicitaron
    if (requestedDeliverables.opportunities) {
      console.log(`🎯 [UX Analysis] Procesando opportunities desde análisis estructurado`)
      responseData.opportunities = structuredAnalysis.opportunities || 
        await detectOpportunities(structuredAnalysis, responseData.ux_assessment, siteInfo, options?.language || 'es')
    }

    // Procesar deliverables adicionales si se solicitaron
    if (requestedDeliverables.competitive_analysis) {
      console.log(`🏆 [UX Analysis] competitive_analysis solicitado pero no implementado aún`)
      responseData.competitive_analysis = { message: 'Funcionalidad próximamente disponible' }
    }

    if (requestedDeliverables.accessibility_audit) {
      console.log(`♿ [UX Analysis] accessibility_audit solicitado pero no implementado aún`)
      responseData.accessibility_audit = { message: 'Funcionalidad próximamente disponible' }
    }

    if (requestedDeliverables.performance_metrics) {
      console.log(`⚡ [UX Analysis] performance_metrics solicitado pero no implementado aún`)
      responseData.performance_metrics = { message: 'Funcionalidad próximamente disponible' }
    }

    // Guardar análisis en base de datos
    const analysisData = {
      site_id,
      url_path: siteInfo.site.url,
      structure: {
        original_analysis: structuredAnalysis,
        branding_analysis: responseData.branding,
        ux_assessment: responseData.ux_assessment,
        recommendations: responseData.recommendations,
        problems: responseData.problems,
        opportunities: responseData.opportunities,
        processing_time: processingTime,
        analysis_type: 'ux_analysis'
      },
      user_id: effectiveUserId,
      status: 'completed' as const,
      request_time: processingTime,
      provider: analysisOptions.provider,
      model_id: analysisOptions.modelId || 'default'
    }

    const savedAnalysis = await createSiteAnalysis(analysisData)

    if (!savedAnalysis) {
      console.error('❌ [UX Analysis] No se pudo guardar el análisis')
      throw new Error('No se pudo guardar el análisis en la base de datos')
    }

    // Actualizar settings.branding solo si se solicita explícitamente
    if (options?.updateBranding === true && siteInfo.settings && responseData.branding) {
      await updateSiteBranding(site_id, responseData.branding, siteInfo.settings.branding)
    }

    // Asignar ID del análisis guardado
    responseData.analysis_id = savedAnalysis.id

    console.log(`✅ [UX Analysis] Análisis UX completado y guardado con ID: ${savedAnalysis.id}`)

    const response: UXAnalysisResponse = {
      success: true,
      data: responseData
    }

    return NextResponse.json(response)

  } catch (error) {
    console.error('❌ [UX Analysis] Error:', error)
    
    let errorMessage = 'Error procesando el análisis UX'
    let errorType = 'ANALYSIS_ERROR'
    let status = 500
    
    if (error instanceof z.ZodError) {
      errorMessage = error.errors[0].message
      errorType = 'VALIDATION_ERROR'
      status = 400
    } else if (error instanceof Error) {
      errorMessage = error.message
    }
    
    return NextResponse.json({
      success: false,
      error: {
        message: errorMessage,
        type: errorType,
        details: error instanceof Error ? error.stack : undefined
      }
    }, { status })
  }
}

// Función para extraer información de branding del análisis
async function extractBrandingFromAnalysis(analysis: any, siteInfo: any, language: string) {
  console.log(`🎨 [UX Analysis] Extrayendo información de branding`)
  
  // Obtener branding existente si existe
  const existingBranding = siteInfo.settings?.branding || {}
  
  // Extraer información del análisis estructurado
  const siteStructure = analysis.structure || {}
  const visualElements = siteStructure.visual_elements || {}
  const content = siteStructure.content || {}
  
  // Inferir pirámide de marca (solo datos del análisis)
  const brandPyramid = {
    brand_essence: content?.main_value_proposition || 
                  content?.hero_message || 
                  `Esencia de marca derivada de ${siteInfo?.site?.name || 'sitio'}`,
    brand_personality: inferBrandPersonality(content, visualElements),
    brand_benefits: content?.benefits?.join(', ') || 
                   'Beneficios identificados del análisis del sitio',
    brand_attributes: content?.key_features?.join(', ') || 
                     'Atributos extraídos del contenido',
    brand_values: content?.company_values?.join(', ') || 
                 'Valores inferidos del análisis',
    brand_promise: content?.value_proposition || 
                  'Promesa de marca basada en el análisis'
  }

  // Extraer paleta de colores (solo datos del análisis)
  const colorPalette = {
    primary_color: visualElements?.primary_color || 
                  extractPrimaryColor(visualElements),
    secondary_color: visualElements?.secondary_color || 
                    extractSecondaryColor(visualElements),
    accent_color: visualElements?.accent_color || 
                 extractAccentColor(visualElements),
    neutral_colors: visualElements?.neutral_colors || 
                   extractNeutralColors(visualElements)
  }

  // Extraer tipografía (solo datos del análisis)
  const typography = {
    primary_font: visualElements?.primary_font || 
                 extractPrimaryFont(visualElements),
    secondary_font: visualElements?.secondary_font || 
                   extractSecondaryFont(visualElements),
    font_hierarchy: describeTypographyHierarchy(visualElements),
    font_sizes: describeFontSizes(visualElements)
  }

  // Inferir voz y tono (solo datos del análisis)
  const voiceAndTone = {
    brand_voice: inferBrandVoice(content),
    communication_style: inferCommunicationStyle(content),
    personality_traits: inferPersonalityTraits(content),
    do_and_dont: generateDoAndDont(content)
  }

  return {
    brand_pyramid: brandPyramid,
    brand_archetype: inferBrandArchetype(content, visualElements),
    color_palette: colorPalette,
    typography: typography,
    voice_and_tone: voiceAndTone,
    brand_guidelines: generateBrandGuidelines(visualElements, content),
    brand_assets: identifyBrandAssets(visualElements, siteInfo.site)
  }
}

// Función para realizar evaluación UX
async function performUXAssessment(analysis: any, siteInfo: any, language: string) {
  console.log(`📊 [UX Analysis] Realizando evaluación UX`)
  
  const structure = analysis.structure || {}
  const performance = analysis.performance || {}
  const accessibility = analysis.accessibility || {}
  
  // Calcular scores individuales
  const usabilityScore = calculateUsabilityScore(structure)
  const accessibilityScore = calculateAccessibilityScore(accessibility)
  const visualDesignScore = calculateVisualDesignScore(structure.visual_elements)
  const performanceScore = calculatePerformanceScore(performance)
  const brandingConsistencyScore = calculateBrandingConsistencyScore(structure, siteInfo)
  
  // Calcular score general
  const overallScore = Math.round(
    (usabilityScore + accessibilityScore + visualDesignScore + performanceScore + brandingConsistencyScore) / 5
  )
  
  return {
    overall_score: overallScore,
    usability_score: usabilityScore,
    accessibility_score: accessibilityScore,
    visual_design_score: visualDesignScore,
    performance_score: performanceScore,
    branding_consistency_score: brandingConsistencyScore,
    user_experience_details: {
      navigation_clarity: calculateNavigationClarity(structure.navigation),
      content_organization: calculateContentOrganization(structure.content),
      visual_hierarchy: calculateVisualHierarchy(structure.visual_elements),
      responsive_design: calculateResponsiveDesign(structure.responsive),
      load_time: calculateLoadTime(performance),
      error_handling: calculateErrorHandling(structure.errors)
    }
  }
}

// Función para generar recomendaciones
async function generateRecommendations(analysis: any, uxAssessment: any, siteInfo: any, language: string) {
  console.log(`💡 [UX Analysis] Generando recomendaciones`)
  
  const recommendations = []
  
  // Recomendaciones basadas en scores bajos
  if (uxAssessment.usability_score < 70) {
    recommendations.push({
      category: 'Usabilidad',
      priority: 'alta' as const,
      effort: 'medio' as const,
      title: 'Mejorar la usabilidad del sitio',
      description: 'El sitio presenta problemas de usabilidad que afectan la experiencia del usuario',
      impact: 'Alto - Mejora significativa en la satisfacción del usuario',
      implementation_steps: [
        'Simplificar la navegación principal',
        'Optimizar formularios y CTAs',
        'Mejorar la búsqueda interna',
        'Implementar breadcrumbs'
      ]
    })
  }
  
  if (uxAssessment.accessibility_score < 70) {
    recommendations.push({
      category: 'Accesibilidad',
      priority: 'alta' as const,
      effort: 'medio' as const,
      title: 'Mejorar la accesibilidad',
      description: 'El sitio no cumple con estándares de accesibilidad web',
      impact: 'Alto - Inclusión de usuarios con discapacidades',
      implementation_steps: [
        'Añadir textos alt a imágenes',
        'Mejorar contraste de colores',
        'Implementar navegación por teclado',
        'Añadir etiquetas ARIA'
      ]
    })
  }
  
  if (uxAssessment.performance_score < 70) {
    recommendations.push({
      category: 'Rendimiento',
      priority: 'media' as const,
      effort: 'alto' as const,
      title: 'Optimizar rendimiento del sitio',
      description: 'El sitio carga lentamente afectando la experiencia del usuario',
      impact: 'Medio - Reducción en la tasa de rebote',
      implementation_steps: [
        'Optimizar imágenes',
        'Minimizar CSS y JavaScript',
        'Implementar lazy loading',
        'Configurar CDN'
      ]
    })
  }
  
  return recommendations
}

// Función para identificar problemas
async function identifyProblems(analysis: any, uxAssessment: any, siteInfo: any, language: string) {
  console.log(`🚨 [UX Analysis] Identificando problemas`)
  
  const problems = []
  
  // Problemas críticos
  if (uxAssessment.overall_score < 50) {
    problems.push({
      category: 'UX General',
      severity: 'crítico' as const,
      title: 'Experiencia de usuario deficiente',
      description: 'El sitio presenta múltiples problemas que afectan severamente la experiencia del usuario',
      user_impact: 'Los usuarios tienen dificultades para completar tareas básicas',
      business_impact: 'Pérdida significativa de conversiones y retención de usuarios',
      suggested_solutions: [
        'Rediseño completo de la interfaz',
        'Investigación de usuarios',
        'Pruebas de usabilidad'
      ]
    })
  }
  
  return problems
}

// Función para detectar oportunidades
async function detectOpportunities(analysis: any, uxAssessment: any, siteInfo: any, language: string) {
  console.log(`🎯 [UX Analysis] Detectando oportunidades`)
  
  const opportunities = []
  
  // Oportunidades de mejora
  if (uxAssessment.branding_consistency_score < 80) {
    opportunities.push({
      category: 'Branding',
      potential: 'alto' as const,
      complexity: 'media' as const,
      title: 'Fortalecer consistencia de marca',
      description: 'Existe oportunidad de mejorar la coherencia visual y comunicativa de la marca',
      expected_outcomes: [
        'Mayor reconocimiento de marca',
        'Mejor posicionamiento',
        'Aumentar confianza del usuario'
      ],
      implementation_timeline: '2-3 meses'
    })
  }
  
  return opportunities
}

// Función para actualizar branding en settings
async function updateSiteBranding(siteId: string, newBrandingData: any, existingBranding: any = {}) {
  console.log(`🔄 [UX Analysis] Actualizando branding en settings`)
  
  try {
    const { supabaseAdmin } = await import('@/lib/database/supabase-client')
    
    // Función recursiva para combinar objetos solo con campos faltantes
    const fillMissingFields = (existing: any, newData: any): any => {
      const result = { ...existing }
      
      for (const key in newData) {
        if (newData[key] !== null && newData[key] !== undefined) {
          if (typeof newData[key] === 'object' && !Array.isArray(newData[key])) {
            // Si es un objeto, hacer merge recursivo
            result[key] = fillMissingFields(existing[key] || {}, newData[key])
          } else if (existing[key] === undefined || existing[key] === null || existing[key] === '') {
            // Solo actualizar si el campo no existe o está vacío
            result[key] = newData[key]
          }
        }
      }
      
      return result
    }
    
    // Combinar branding existente con nuevos datos solo donde falten campos
    const mergedBranding = fillMissingFields(existingBranding, newBrandingData)
    
    const { error } = await supabaseAdmin
      .from('settings')
      .update({
        branding: mergedBranding,
        updated_at: new Date().toISOString()
      })
      .eq('site_id', siteId)
    
    if (error) {
      console.error('❌ [UX Analysis] Error actualizando branding:', error)
      throw error
    }
    
    console.log('✅ [UX Analysis] Branding actualizado correctamente (solo campos faltantes)')
  } catch (error) {
    console.error('❌ [UX Analysis] Error actualizando branding:', error)
    throw error
  }
}

// Funciones auxiliares para análisis de branding
function inferBrandPersonality(content: any, visualElements: any): string {
  // Lógica para inferir personalidad de marca
  const tone = content?.tone || 'neutral'
  const style = visualElements?.style || 'professional'
  
  if (tone === 'friendly' && style === 'modern') return 'Amigable y moderna'
  if (tone === 'professional' && style === 'corporate') return 'Profesional y corporativa'
  
  return 'Personalidad equilibrada y adaptable'
}

function extractPrimaryColor(visualElements: any): string {
  return visualElements?.colors?.[0] || '#000000'
}

function extractSecondaryColor(visualElements: any): string {
  return visualElements?.colors?.[1] || '#666666'
}

function extractAccentColor(visualElements: any): string {
  return visualElements?.colors?.[2] || '#0066CC'
}

function extractNeutralColors(visualElements: any): string[] {
  return visualElements?.neutral_colors || ['#FFFFFF', '#F5F5F5', '#E5E5E5']
}

function extractPrimaryFont(visualElements: any): string {
  return visualElements?.fonts?.[0] || 'Arial, sans-serif'
}

function extractSecondaryFont(visualElements: any): string {
  return visualElements?.fonts?.[1] || 'Georgia, serif'
}

function describeTypographyHierarchy(visualElements: any): string {
  return 'Jerarquía tipográfica clara con títulos prominentes y texto legible'
}

function describeFontSizes(visualElements: any): string {
  return 'Escala tipográfica equilibrada desde 14px hasta 48px'
}

function inferBrandVoice(content: any): string {
  const tone = content?.tone || 'neutral'
  return tone === 'friendly' ? 'Cercana y confiable' : 'Profesional y experta'
}

function inferCommunicationStyle(content: any): string {
  return 'Comunicación clara y directa con enfoque en valor al usuario'
}

function inferPersonalityTraits(content: any): string[] {
  return ['Confiable', 'Innovadora', 'Orientada al usuario']
}

function generateDoAndDont(content: any): { do: string[]; dont: string[] } {
  return {
    do: [
      'Usar un lenguaje claro y directo',
      'Mantener consistencia en el tono',
      'Enfocarse en beneficios del usuario'
    ],
    dont: [
      'Usar jerga técnica excesiva',
      'Cambiar el tono entre secciones',
      'Hacer promesas irreales'
    ]
  }
}

function inferBrandArchetype(content: any, visualElements: any): string {
  return 'El Sabio - Experto y confiable'
}

function generateBrandGuidelines(visualElements: any, content: any): any {
  return {
    logo_usage: 'Usar logo en alta resolución con espaciado adecuado',
    color_usage: 'Aplicar colores según paleta establecida',
    typography_usage: 'Mantener jerarquía tipográfica consistente',
    imagery_style: 'Imágenes profesionales y de alta calidad',
    messaging_guidelines: 'Mensajes claros y orientados al valor'
  }
}

function identifyBrandAssets(visualElements: any, site: any): any {
  return {
    logo_variations: [site?.logo_url].filter(Boolean),
    color_swatches: visualElements?.colors || [],
    font_files: visualElements?.fonts || [],
    templates: []
  }
}

// Funciones auxiliares para cálculo de scores
function calculateUsabilityScore(structure: any): number {
  // Lógica simplificada para calcular score de usabilidad
  let score = 70 // Base score
  
  if (structure?.navigation?.length > 0) score += 10
  if (structure?.forms?.length > 0) score += 5
  if (structure?.search) score += 5
  if (structure?.footer) score += 5
  if (structure?.breadcrumbs) score += 5
  
  return Math.min(score, 100)
}

function calculateAccessibilityScore(accessibility: any): number {
  let score = 60 // Base score
  
  if (accessibility?.alt_texts > 0.8) score += 15
  if (accessibility?.color_contrast > 0.7) score += 15
  if (accessibility?.keyboard_navigation) score += 10
  
  return Math.min(score, 100)
}

function calculateVisualDesignScore(visualElements: any): number {
  let score = 65 // Base score
  
  if (visualElements?.colors?.length > 0) score += 10
  if (visualElements?.fonts?.length > 0) score += 10
  if (visualElements?.layout === 'responsive') score += 15
  
  return Math.min(score, 100)
}

function calculatePerformanceScore(performance: any): number {
  let score = 50 // Base score
  
  if (performance?.load_time < 3) score += 20
  if (performance?.load_time < 2) score += 15
  if (performance?.load_time < 1.5) score += 15
  
  return Math.min(score, 100)
}

function calculateBrandingConsistencyScore(structure: any, siteInfo: any): number {
  let score = 60 // Base score
  
  if (siteInfo?.settings?.branding) score += 20
  if (structure?.visual_elements?.colors?.length > 0) score += 10
  if (structure?.visual_elements?.fonts?.length > 0) score += 10
  
  return Math.min(score, 100)
}

function calculateNavigationClarity(navigation: any): number {
  return navigation?.length ? Math.min(navigation.length * 15, 100) : 60
}

function calculateContentOrganization(content: any): number {
  return content?.sections?.length ? Math.min(content.sections.length * 12, 100) : 65
}

function calculateVisualHierarchy(visualElements: any): number {
  return visualElements?.hierarchy ? 85 : 70
}

function calculateResponsiveDesign(responsive: any): number {
  return responsive?.mobile_friendly ? 90 : 60
}

function calculateLoadTime(performance: any): number {
  const loadTime = performance?.load_time || 3
  return Math.max(100 - (loadTime * 20), 20)
}

function calculateErrorHandling(errors: any): number {
  return errors?.length ? Math.max(100 - (errors.length * 10), 40) : 85
}

export async function GET(request: NextRequest) {
  return NextResponse.json({
    message: 'UX & Branding Analysis API',
    description: 'Analiza la experiencia de usuario y branding de un sitio web utilizando únicamente el site_id',
    usage: 'Envía una solicitud POST con site_id y deliverables opcionales',
    example: {
      site_id: 'uuid-del-sitio',
      options: {
        timeout: 60000,
        includeScreenshot: true,
        provider: 'openai',
        modelId: 'gpt-4.1',
        updateBranding: false,
        language: 'es'
      },
      deliverables: {
        branding_analysis: true,
        ux_assessment: true,
        recommendations: true,
        problems: true,
        opportunities: true,
        competitive_analysis: false,
        accessibility_audit: false,
        performance_metrics: false
      }
    },
    deliverables_options: {
      branding_analysis: 'Análisis completo de marca: pirámide, arquetipo, paleta de colores, tipografía, voz y tono',
      ux_assessment: 'Evaluación de experiencia de usuario con scores detallados',
      recommendations: 'Recomendaciones categorizadas con prioridad y esfuerzo',
      problems: 'Identificación de problemas con severidad y soluciones',
      opportunities: 'Detección de oportunidades con potencial y complejidad',
      competitive_analysis: 'Análisis competitivo (próximamente)',
      accessibility_audit: 'Auditoría de accesibilidad (próximamente)',
      performance_metrics: 'Métricas de rendimiento (próximamente)'
    },
    features: [
      'Análisis automático de branding con deliverables específicos',
      'Evaluación de experiencia de usuario',
      'Recomendaciones categorizadas por prioridad',
      'Identificación de problemas por severidad',
      'Detección de oportunidades de mejora',
      'Deliverables personalizables según necesidades',
      'Actualización opcional de settings.branding (solo campos faltantes)'
    ]
  })
} 