import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { performStructuredAnalysis } from '@/lib/services/structured-analyzer-service'
import { upsertSiteAnalysis } from '@/lib/database/site-analysis-db'
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
 * - Completado automático del objeto settings.branding (solo campos faltantes)
 * - Generación de recomendaciones UX
 * - Identificación de problemas y oportunidades
 * - Guardado del análisis en la base de datos
 * - Actualización automática de branding en settings (preserva datos existentes)
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
    updateBranding: z.boolean().default(true).optional(),
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
      positioning: {
        brand_promise: string
        target_market: string
        value_proposition: string
        competitive_advantage: string
      }
      brand_pyramid: {
        values: string[]
        vision: string
        mission: string
        purpose: string
        personality_traits: string[]
      }
      voice_and_tone: {
        do_say: string[]
        dont_say: string[]
        personality: string
        tone_attributes: string[]
        communication_style: string
      }
      brand_archetype: string
      visual_identity: {
        logo_style: string | null
        typography: string | null
        color_palette: string[]
        imagery_style: string | null
        design_principles: string[]
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
      responseData.branding = await extractBrandingFromAnalysis(structuredAnalysis, siteInfo, options?.language || 'es')
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
        branding_analysis: responseData.branding, // Esta es la estructura plana
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

    const savedAnalysis = await upsertSiteAnalysis(analysisData)

    if (!savedAnalysis) {
      console.error('❌ [UX Analysis] No se pudo guardar el análisis')
      throw new Error('No se pudo guardar el análisis en la base de datos')
    }

    // Actualizar settings.branding automáticamente si hay datos de branding disponibles
    if (responseData.branding && siteInfo.settings !== undefined) {
      try {
        await updateSiteBranding(site_id, responseData.branding, siteInfo.settings?.branding)
        console.log(`✅ [UX Analysis] Branding actualizado en settings para sitio: ${site_id}`)
      } catch (error) {
        console.error(`❌ [UX Analysis] Error actualizando branding en settings: ${error}`)
        // No falla la petición completa, solo log el error
      }
    } else if (responseData.branding && siteInfo.settings === undefined) {
      console.warn(`⚠️ [UX Analysis] No se encontró settings para actualizar branding en sitio: ${site_id}`)
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
  
  // Si el análisis estructurado contiene branding_analysis, usarlo directamente
  if (analysis.branding_analysis) {
    console.log(`🎨 [UX Analysis] Usando branding_analysis del análisis estructurado`)
    const brandingAnalysis = analysis.branding_analysis
    
    // Estructura plana como se usa en la base de datos
    const flatBranding = {
      // Brand pyramid fields (flat)
      brand_essence: brandingAnalysis.brand_pyramid?.brand_essence || 'Esencia de marca extraída del análisis del sitio',
      brand_personality: brandingAnalysis.brand_pyramid?.brand_personality || 'Personalidad innovadora y confiable',
      brand_benefits: brandingAnalysis.brand_pyramid?.brand_benefits || 'Beneficios extraídos del análisis del sitio',
      brand_attributes: brandingAnalysis.brand_pyramid?.brand_attributes || 'Atributos identificados en el análisis',
      brand_values: brandingAnalysis.brand_pyramid?.brand_values || 'Innovación, calidad, orientación al cliente',
      brand_promise: brandingAnalysis.brand_pyramid?.brand_promise || 'Promesa de marca basada en el análisis del sitio',
      
      // Brand archetype (flat) - extraer solo el valor principal
      brand_archetype: extractArchetypeValue(brandingAnalysis.brand_archetype),
      
      // Color palette (flat) - extraer todos los colores
      primary_color: brandingAnalysis.color_palette?.primary_color || '#2563eb',
      secondary_color: brandingAnalysis.color_palette?.secondary_color || '#1e293b',
      accent_color: brandingAnalysis.color_palette?.accent_color || '#6366f1',
      success_color: '#22c55e',
      warning_color: '#f59e0b',
      error_color: '#ef4444',
      background_color: '#ffffff',
      surface_color: '#f8fafc',
      
      // Typography (flat) - extraer toda la info tipográfica
      primary_font: brandingAnalysis.typography?.primary_font || 'Inter, sans-serif',
      secondary_font: brandingAnalysis.typography?.secondary_font || 'system-ui, sans-serif',
      font_size_scale: 'medium',
      font_hierarchy: brandingAnalysis.typography?.font_hierarchy || 'Jerarquía tipográfica clara y legible',
      font_sizes: brandingAnalysis.typography?.font_sizes || 'xs, sm, base, lg, xl, 2xl, 3xl, 4xl, 5xl, 6xl, 7xl',
      
      // Voice and tone (flat)
      communication_style: brandingAnalysis.voice_and_tone?.communication_style || 'friendly',
      personality_traits: brandingAnalysis.voice_and_tone?.personality_traits || ['profesional', 'innovador', 'confiable'],
      brand_voice: brandingAnalysis.voice_and_tone?.brand_voice || 'Voz profesional e inspiradora',
      
      // Brand guidelines (flat) - extraer do_and_dont
      do_list: brandingAnalysis.voice_and_tone?.do_and_dont?.do || [],
      dont_list: brandingAnalysis.voice_and_tone?.do_and_dont?.dont || [],
      forbidden_words: brandingAnalysis.voice_and_tone?.do_and_dont?.dont || [],
      preferred_phrases: brandingAnalysis.voice_and_tone?.do_and_dont?.do || [],
      emotions_to_evoke: [],
      
      // Brand guidelines additional (flat)
      logo_usage: brandingAnalysis.brand_guidelines?.logo_usage || 'Uso consistente del logotipo',
      color_usage: brandingAnalysis.brand_guidelines?.color_usage || 'Aplicación coherente de colores',
      imagery_style: brandingAnalysis.brand_guidelines?.imagery_style || 'Estilo visual consistente',
      typography_usage: brandingAnalysis.brand_guidelines?.typography_usage || 'Jerarquía tipográfica clara',
      messaging_guidelines: brandingAnalysis.brand_guidelines?.messaging_guidelines || 'Mensajes centrados en valor y beneficios',
      
      // Brand assets (flat) - extraer todos los assets
      logo_variations: brandingAnalysis.brand_assets?.logo_variations || [],
      templates: brandingAnalysis.brand_assets?.templates || [],
      font_files: brandingAnalysis.brand_assets?.font_files || [],
      color_swatches: brandingAnalysis.brand_assets?.color_swatches || [
        brandingAnalysis.color_palette?.primary_color || '#2563eb',
        brandingAnalysis.color_palette?.secondary_color || '#1e293b',
        brandingAnalysis.color_palette?.accent_color || '#6366f1',
        '#ffffff'
      ],
      
      // Neutral colors (flat)
      neutral_colors: brandingAnalysis.color_palette?.neutral_colors || ['#ffffff', '#f2f6fe', '#4b5563']
    }
    
    console.log(`✅ [UX Analysis] Branding extraído y mapeado a estructura plana:`, {
      brand_essence: flatBranding.brand_essence,
      brand_archetype: flatBranding.brand_archetype,
      primary_color: flatBranding.primary_color,
      communication_style: flatBranding.communication_style,
      fields_mapped: Object.keys(flatBranding).length
    })
    
    return flatBranding
  }
  
  // Fallback: usar análisis manual si no hay branding_analysis
  console.log(`⚠️ [UX Analysis] No hay branding_analysis en el análisis estructurado, usando fallback`)
  
  // Extraer información del análisis estructurado básico
  const siteStructure = analysis.structure || {}
  const visualElements = siteStructure.visual_elements || {}
  const content = siteStructure.content || {}
  
  // Estructura plana para fallback
  return {
    // Brand pyramid fields (flat)
    brand_essence: content?.brand_essence || 
                  content?.value_proposition || 
                  'Esencia de marca basada en el análisis del sitio',
    brand_personality: inferBrandPersonality(content, visualElements),
    brand_benefits: content?.benefits || 
                   content?.value_proposition || 
                   'Beneficios extraídos del análisis',
    brand_attributes: content?.attributes || 
                     inferBrandAttributes(content, visualElements),
    brand_values: extractValues(content),
    brand_promise: content?.promise || 
                  content?.value_proposition || 
                  'Promesa de marca basada en el análisis',
    
    // Brand archetype (flat)
    brand_archetype: inferBrandArchetype(content, visualElements),
    
    // Color palette (flat)
    primary_color: visualElements?.colors?.[0] || '#2563eb',
    secondary_color: visualElements?.colors?.[1] || '#1e293b',
    accent_color: visualElements?.colors?.[2] || '#6366f1',
    success_color: '#22c55e',
    warning_color: '#f59e0b',
    error_color: '#ef4444',
    background_color: '#ffffff',
    surface_color: '#f8fafc',
    
    // Typography (flat)
    primary_font: visualElements?.fonts?.[0] || 'Inter, sans-serif',
    secondary_font: visualElements?.fonts?.[1] || 'system-ui, sans-serif',
    font_size_scale: 'medium',
    font_hierarchy: 'Jerarquía tipográfica clara y legible',
    font_sizes: 'xs, sm, base, lg, xl, 2xl, 3xl, 4xl, 5xl, 6xl, 7xl',
    
    // Voice and tone (flat)
    communication_style: inferCommunicationStyle(content),
    personality_traits: inferPersonalityTraits(content, visualElements),
    brand_voice: 'Voz profesional e inspiradora',
    forbidden_words: [],
    preferred_phrases: [],
    
    // Brand guidelines (flat)
    do_list: [],
    dont_list: [],
    emotions_to_evoke: [],
    logo_usage: 'Uso consistente del logotipo',
    color_usage: 'Aplicación coherente de colores',
    imagery_style: 'Estilo visual consistente',
    typography_usage: 'Jerarquía tipográfica clara',
    messaging_guidelines: 'Mensajes centrados en valor y beneficios',
    
    // Brand assets (flat)
    logo_variations: [],
    templates: [],
    font_files: [],
    color_swatches: [],
    neutral_colors: ['#ffffff', '#f2f6fe', '#4b5563']
  }
}

// Función auxiliar para extraer el valor principal del brand archetype
function extractArchetypeValue(archetype: string): string {
  if (!archetype || typeof archetype !== 'string') return 'sage'
  
  // Buscar palabras clave en el archetype para determinar el valor principal
  const lowerArchetype = archetype.toLowerCase()
  
  if (lowerArchetype.includes('sabio') || lowerArchetype.includes('sage') || lowerArchetype.includes('wise')) {
    return 'sage'
  }
  if (lowerArchetype.includes('mago') || lowerArchetype.includes('magician')) {
    return 'magician'
  }
  if (lowerArchetype.includes('héroe') || lowerArchetype.includes('hero')) {
    return 'hero'
  }
  if (lowerArchetype.includes('cuidador') || lowerArchetype.includes('caregiver')) {
    return 'caregiver'
  }
  if (lowerArchetype.includes('explorador') || lowerArchetype.includes('explorer')) {
    return 'explorer'
  }
  if (lowerArchetype.includes('rebelde') || lowerArchetype.includes('rebel')) {
    return 'rebel'
  }
  if (lowerArchetype.includes('amante') || lowerArchetype.includes('lover')) {
    return 'lover'
  }
  if (lowerArchetype.includes('creador') || lowerArchetype.includes('creator')) {
    return 'creator'
  }
  if (lowerArchetype.includes('inocente') || lowerArchetype.includes('innocent')) {
    return 'innocent'
  }
  if (lowerArchetype.includes('bufón') || lowerArchetype.includes('jester')) {
    return 'jester'
  }
  if (lowerArchetype.includes('ciudadano') || lowerArchetype.includes('citizen')) {
    return 'citizen'
  }
  if (lowerArchetype.includes('gobernante') || lowerArchetype.includes('ruler')) {
    return 'ruler'
  }
  
  // Si menciona múltiples arquetipos, usar el primero que encuentre
  if (lowerArchetype.includes('sabio') || lowerArchetype.includes('mago')) {
    return 'sage' // Default para combinaciones que incluyen sabio
  }
  
  return 'sage' // Default fallback
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
  console.log(`🔄 [UX Analysis] Actualizando branding en settings para sitio: ${siteId}`)
  
  if (!siteId) {
    throw new Error('Site ID es requerido para actualizar branding')
  }
  
  if (!newBrandingData || typeof newBrandingData !== 'object') {
    throw new Error('Datos de branding inválidos')
  }
  
  try {
    const { supabaseAdmin } = await import('@/lib/database/supabase-client')
    
    // Función simple para combinar objetos solo con campos faltantes (estructura plana)
    const fillMissingFields = (existing: any, newData: any): any => {
      const result = { ...existing }
      
      for (const key in newData) {
        if (newData[key] !== null && newData[key] !== undefined) {
          // Para estructura plana, solo actualizar si el campo no existe o está vacío
          if (existing[key] === undefined || existing[key] === null || existing[key] === '') {
            result[key] = newData[key]
          }
        }
      }
      
      return result
    }
    
    // Combinar branding existente con nuevos datos solo donde falten campos
    const mergedBranding = fillMissingFields(existingBranding, newBrandingData)
    
    // Contar campos que se van a actualizar
    const fieldsToUpdate = countFieldsToUpdate(existingBranding, newBrandingData)
    console.log(`🔄 [UX Analysis] Actualizando ${fieldsToUpdate} campos de branding faltantes`)
    console.log(`🔍 [UX Analysis] Campos nuevos de branding:`, Object.keys(newBrandingData))
    
    // Verificar que el sitio existe en settings
    const { data: existingSite, error: queryError } = await supabaseAdmin
      .from('settings')
      .select('id, branding')
      .eq('site_id', siteId)
      .single()
    
    if (queryError && queryError.code !== 'PGRST116') {
      console.error('❌ [UX Analysis] Error verificando sitio en settings:', queryError)
      throw queryError
    }
    
    if (!existingSite) {
      console.warn(`⚠️ [UX Analysis] No se encontró configuración para sitio: ${siteId}`)
      return
    }
    
    const { error: updateError } = await supabaseAdmin
      .from('settings')
      .update({
        branding: mergedBranding,
        updated_at: new Date().toISOString()
      })
      .eq('site_id', siteId)
    
    if (updateError) {
      console.error('❌ [UX Analysis] Error actualizando branding:', updateError)
      throw updateError
    }
    
    console.log(`✅ [UX Analysis] Branding actualizado correctamente (${fieldsToUpdate} campos faltantes)`)
    console.log(`🎯 [UX Analysis] Estructura final del branding:`, {
      total_fields: Object.keys(mergedBranding).length,
      sample_fields: Object.keys(mergedBranding).slice(0, 5)
    })
  } catch (error) {
    console.error('❌ [UX Analysis] Error actualizando branding:', error)
    throw error
  }
}

// Función auxiliar para contar campos que se van a actualizar (simplificada para estructura plana)
function countFieldsToUpdate(existing: any, newData: any): number {
  let count = 0
  for (const key in newData) {
    if (newData[key] !== null && newData[key] !== undefined) {
      if (existing[key] === undefined || existing[key] === null || existing[key] === '') {
        count++
      }
    }
  }
  return count
}

// Funciones auxiliares para análisis de branding
function inferBrandPersonality(content: any, visualElements: any): string {
  // Lógica para inferir personalidad de marca
  const tone = content?.tone || content?.communication_style || 'neutral'
  const style = visualElements?.style || 'professional'
  
  if (tone === 'friendly' && style === 'modern') return 'Amigable y moderna'
  if (tone === 'professional' && style === 'corporate') return 'Profesional y corporativa'
  if (tone.includes('friendly') || tone.includes('amigable')) return 'Amigable y accesible'
  if (tone.includes('professional') || tone.includes('profesional')) return 'Profesional y confiable'
  
  return 'Personalidad equilibrada y adaptable'
}

function inferTargetMarket(content: any, siteInfo: any): string {
  // Inferir mercado objetivo basado en el contenido
  const industry = content?.industry || siteInfo?.site?.industry || 'Servicios profesionales'
  const audience = content?.target_audience || content?.audience || 'Profesionales y empresas'
  
  // Si es brandingAnalysis, puede tener estructura diferente
  if (content?.brand_pyramid?.brand_attributes) {
    const attributes = content.brand_pyramid.brand_attributes
    return `${industry} orientado a ${attributes.toLowerCase()}`
  }
  
  return `${industry} - ${audience}`
}

function inferCompetitiveAdvantage(content: any, visualElements: any): string {
  // Inferir ventaja competitiva
  const features = content?.key_features || []
  const uniqueValue = content?.unique_value || content?.differentiator || content?.brand_promise
  
  if (uniqueValue) return uniqueValue
  if (features.length > 0) return `Enfoque especializado en ${features.slice(0, 2).join(' y ')}`
  
  // Si hay brand_pyramid, usar brand_attributes
  if (content?.brand_pyramid?.brand_attributes) {
    return content.brand_pyramid.brand_attributes
  }
  
  return 'Solución innovadora y orientada al cliente'
}

function extractValues(content: any): string {
  // Extraer valores de la compañía
  if (content?.company_values && Array.isArray(content.company_values)) {
    return content.company_values.join(', ')
  }
  
  if (content?.values && Array.isArray(content.values)) {
    return content.values.join(', ')
  }
  
  // Si es brandingAnalysis, puede tener brand_values
  if (content?.brand_pyramid?.brand_values) {
    return content.brand_pyramid.brand_values
  }
  
  // Si hay personality_traits, usarlos como valores
  if (content?.voice_and_tone?.personality_traits && Array.isArray(content.voice_and_tone.personality_traits)) {
    return content.voice_and_tone.personality_traits.join(', ')
  }
  
  // Valores por defecto basados en el análisis
  return 'Innovación, calidad, orientación al cliente'
}

function inferVision(content: any, siteInfo: any): string {
  // Inferir visión de la empresa
  const vision = content?.vision || content?.company_vision
  if (vision) return vision
  
  // Si es brandingAnalysis, usar brand_essence
  if (content?.brand_pyramid?.brand_essence) {
    return `Ser reconocidos por ${content.brand_pyramid.brand_essence.toLowerCase()}`
  }
  
  const siteName = siteInfo?.site?.name || 'nuestra empresa'
  const industry = content?.industry || siteInfo?.site?.industry || 'nuestra industria'
  
  return `Ser líder en ${industry} a través de ${siteName}`
}

function inferMission(content: any, siteInfo: any): string {
  // Inferir misión de la empresa
  const mission = content?.mission || content?.company_mission
  if (mission) return mission
  
  // Si es brandingAnalysis, usar brand_promise
  if (content?.brand_pyramid?.brand_promise) {
    return content.brand_pyramid.brand_promise
  }
  
  const valueProposition = content?.value_proposition || content?.main_value_proposition || content?.brand_pyramid?.brand_benefits
  if (valueProposition) return valueProposition
  
  return 'Proporcionar soluciones innovadoras que generen valor para nuestros clientes'
}

function inferPurpose(content: any, siteInfo: any): string {
  // Inferir propósito de la empresa
  const purpose = content?.purpose || content?.company_purpose
  if (purpose) return purpose
  
  // Si es brandingAnalysis, usar brand_essence
  if (content?.brand_pyramid?.brand_essence) {
    return content.brand_pyramid.brand_essence
  }
  
  const siteName = siteInfo?.site?.name || 'nuestra empresa'
  return `Transformar la experiencia del cliente a través de ${siteName}`
}

function inferPersonalityTraits(content: any, visualElements: any): string[] {
  // Inferir rasgos de personalidad
  const traits = []
  
  // Si es brandingAnalysis, usar personality_traits
  if (content?.voice_and_tone?.personality_traits && Array.isArray(content.voice_and_tone.personality_traits)) {
    return content.voice_and_tone.personality_traits
  }
  
  // Si hay brand_personality, usarlo
  if (content?.brand_pyramid?.brand_personality) {
    traits.push(content.brand_pyramid.brand_personality)
  }
  
  const tone = content?.tone || content?.communication_style || 'neutral'
  const style = visualElements?.style || 'professional'
  
  if (tone === 'friendly' || tone.includes('amigable')) traits.push('Amigable')
  if (tone === 'professional' || tone.includes('profesional')) traits.push('Profesional')
  if (style === 'modern' || style.includes('moderno')) traits.push('Innovador')
  if (style === 'corporate' || style.includes('corporativo')) traits.push('Confiable')
  
  // Agregar rasgos adicionales si no hay suficientes
  if (traits.length === 0) {
    traits.push('Confiable', 'Innovador', 'Orientado al cliente')
  }
  
  return traits
}

function generateDoSay(content: any): string[] {
  // Generar lista de qué decir
  const doSay = []
  
  // Si es brandingAnalysis, usar do_and_dont
  if (content?.voice_and_tone?.do_and_dont?.do && Array.isArray(content.voice_and_tone.do_and_dont.do)) {
    return content.voice_and_tone.do_and_dont.do
  }
  
  if (content?.benefits) {
    doSay.push('Resaltar beneficios clave')
  }
  
  if (content?.value_proposition || content?.brand_pyramid?.brand_benefits) {
    doSay.push('Enfocarse en la propuesta de valor')
  }
  
  if (content?.brand_pyramid?.brand_promise) {
    doSay.push('Comunicar la promesa de marca')
  }
  
  // Mensajes por defecto
  if (doSay.length === 0) {
    doSay.push('Destacar el valor único', 'Usar lenguaje claro y directo', 'Demostrar experiencia y confiabilidad')
  }
  
  return doSay
}

function generateDontSay(content: any): string[] {
  // Generar lista de qué no decir
  const dontSay = []
  
  // Si es brandingAnalysis, usar do_and_dont
  if (content?.voice_and_tone?.do_and_dont?.dont && Array.isArray(content.voice_and_tone.do_and_dont.dont)) {
    return content.voice_and_tone.do_and_dont.dont
  }
  
  // Mensajes por defecto
  dontSay.push('Evitar promesas exageradas', 'No usar jerga técnica excesiva', 'Evitar mensajes confusos o ambiguos')
  
  return dontSay
}

function inferToneAttributes(content: any): string[] {
  // Inferir atributos de tono
  const attributes = []
  
  // Si es brandingAnalysis, usar personality_traits
  if (content?.voice_and_tone?.personality_traits && Array.isArray(content.voice_and_tone.personality_traits)) {
    return content.voice_and_tone.personality_traits
  }
  
  const tone = content?.tone || content?.communication_style || 'neutral'
  
  if (tone === 'friendly' || tone.includes('amigable')) attributes.push('Cercano')
  if (tone === 'professional' || tone.includes('profesional')) attributes.push('Profesional')
  if (tone === 'confident' || tone.includes('confiado')) attributes.push('Seguro')
  if (tone.includes('clear') || tone.includes('claro')) attributes.push('Claro')
  
  // Atributos por defecto
  if (attributes.length === 0) {
    attributes.push('Confiable', 'Claro', 'Profesional')
  }
  
  return attributes
}

function inferCommunicationStyle(content: any): string {
  // Si es brandingAnalysis, usar communication_style
  if (content?.voice_and_tone?.communication_style) {
    return content.voice_and_tone.communication_style
  }
  
  const tone = content?.tone || 'neutral'
  const style = content?.style || 'professional'
  
  if (tone === 'friendly' && style === 'casual') {
    return 'friendly'
  }
  if (tone === 'professional' && style === 'corporate') {
    return 'professional'
  }
  
  return 'friendly'
}

function inferBrandArchetype(content: any, visualElements: any): string {
  // Si es brandingAnalysis, usar brand_archetype
  if (content?.brand_archetype) {
    return content.brand_archetype
  }
  
  const tone = content?.tone || content?.communication_style || 'neutral'
  const personality = content?.brand_pyramid?.brand_personality || ''
  
  if (tone.includes('expert') || tone.includes('experto') || personality.includes('experto')) {
    return 'sage'
  }
  if (tone.includes('innovative') || tone.includes('innovador') || personality.includes('innovador')) {
    return 'magician'
  }
  if (tone.includes('caring') || tone.includes('cuidador') || personality.includes('cuidador')) {
    return 'caregiver'
  }
  
  return 'sage'
}

function inferBrandAttributes(content: any, visualElements: any): string {
  // Inferir atributos de marca basados en el contenido y elementos visuales
  const attributes = []
  
  // Analizar características técnicas
  if (content?.features && Array.isArray(content.features)) {
    attributes.push(...content.features.slice(0, 3))
  }
  
  // Analizar estilo visual
  if (visualElements?.style) {
    if (visualElements.style.includes('modern')) attributes.push('moderno')
    if (visualElements.style.includes('professional')) attributes.push('profesional')
    if (visualElements.style.includes('clean')) attributes.push('limpio')
  }
  
  // Analizar contenido para inferir atributos
  if (content?.value_proposition) {
    if (content.value_proposition.includes('fácil')) attributes.push('fácil de usar')
    if (content.value_proposition.includes('rápido')) attributes.push('eficiente')
    if (content.value_proposition.includes('seguro')) attributes.push('confiable')
  }
  
  // Atributos por defecto si no se encuentra información específica
  if (attributes.length === 0) {
    attributes.push('innovador', 'confiable', 'profesional')
  }
  
  return attributes.join(', ')
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
    description: 'Analiza la experiencia de usuario y branding de un sitio web, guardando el análisis en la base de datos y actualizando automáticamente los campos faltantes en settings.branding',
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
      'Actualización automática de settings.branding (solo campos faltantes)'
    ],
    important_notes: [
      'El análisis siempre se guarda en la base de datos con todos los datos generados',
      'El branding se actualiza automáticamente en settings.branding preservando datos existentes',
      'Solo se actualizan campos de branding que estén vacíos o no existan en la base de datos',
      'El proceso no sobrescribe información existente, solo completa campos faltantes'
    ]
  })
} 