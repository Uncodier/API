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

// Esquema de validación para campos de branding
const BrandingSchema = z.object({
  // Brand pyramid fields
  brand_essence: z.string().min(10, 'Brand essence debe tener al menos 10 caracteres').max(500, 'Brand essence no puede exceder 500 caracteres').optional(),
  brand_personality: z.string().min(10, 'Brand personality debe tener al menos 10 caracteres').max(300, 'Brand personality no puede exceder 300 caracteres').optional(),
  brand_benefits: z.string().min(10, 'Brand benefits debe tener al menos 10 caracteres').max(500, 'Brand benefits no puede exceder 500 caracteres').optional(),
  brand_attributes: z.string().min(10, 'Brand attributes debe tener al menos 10 caracteres').max(500, 'Brand attributes no puede exceder 500 caracteres').optional(),
  brand_values: z.string().min(10, 'Brand values debe tener al menos 10 caracteres').max(300, 'Brand values no puede exceder 300 caracteres').optional(),
  brand_promise: z.string().min(10, 'Brand promise debe tener al menos 10 caracteres').max(500, 'Brand promise no puede exceder 500 caracteres').optional(),
  
  // Brand archetype - valores permitidos
  brand_archetype: z.enum([
    'sage', 'magician', 'hero', 'caregiver', 'explorer', 'rebel', 
    'lover', 'creator', 'innocent', 'jester', 'citizen', 'ruler'
  ], { errorMap: () => ({ message: 'Brand archetype debe ser uno de los arquetipos válidos' }) }).optional(),
  
  // Color palette - validación de colores hex
  primary_color: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Primary color debe ser un código hex válido (#RRGGBB)').optional(),
  secondary_color: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Secondary color debe ser un código hex válido (#RRGGBB)').optional(),
  accent_color: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Accent color debe ser un código hex válido (#RRGGBB)').optional(),
  success_color: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Success color debe ser un código hex válido (#RRGGBB)').optional(),
  warning_color: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Warning color debe ser un código hex válido (#RRGGBB)').optional(),
  error_color: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Error color debe ser un código hex válido (#RRGGBB)').optional(),
  background_color: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Background color debe ser un código hex válido (#RRGGBB)').optional(),
  surface_color: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Surface color debe ser un código hex válido (#RRGGBB)').optional(),
  
  // Typography
  primary_font: z.string().min(3, 'Primary font debe tener al menos 3 caracteres').max(100, 'Primary font no puede exceder 100 caracteres').optional(),
  secondary_font: z.string().min(3, 'Secondary font debe tener al menos 3 caracteres').max(100, 'Secondary font no puede exceder 100 caracteres').optional(),
  font_size_scale: z.enum(['small', 'medium', 'large'], { errorMap: () => ({ message: 'Font size scale debe ser small, medium o large' }) }).optional(),
  font_hierarchy: z.string().min(10, 'Font hierarchy debe tener al menos 10 caracteres').max(300, 'Font hierarchy no puede exceder 300 caracteres').optional(),
  font_sizes: z.string().min(10, 'Font sizes debe tener al menos 10 caracteres').max(200, 'Font sizes no puede exceder 200 caracteres').optional(),
  
  // Voice and tone
  communication_style: z.enum(['friendly', 'professional', 'casual', 'formal', 'authoritative', 'conversational'], { 
    errorMap: () => ({ message: 'Communication style debe ser uno de los estilos válidos' }) 
  }).optional(),
  personality_traits: z.array(z.string().min(2, 'Cada personality trait debe tener al menos 2 caracteres')).max(10, 'Máximo 10 personality traits').optional(),
  brand_voice: z.string().min(10, 'Brand voice debe tener al menos 10 caracteres').max(300, 'Brand voice no puede exceder 300 caracteres').optional(),
  
  // Brand guidelines
  do_list: z.array(z.string().min(5, 'Cada elemento de do_list debe tener al menos 5 caracteres')).max(20, 'Máximo 20 elementos en do_list').optional(),
  dont_list: z.array(z.string().min(5, 'Cada elemento de dont_list debe tener al menos 5 caracteres')).max(20, 'Máximo 20 elementos en dont_list').optional(),
  forbidden_words: z.array(z.string().min(1, 'Cada forbidden word debe tener al menos 1 caracter')).max(50, 'Máximo 50 forbidden words').optional(),
  preferred_phrases: z.array(z.string().min(2, 'Cada preferred phrase debe tener al menos 2 caracteres')).max(50, 'Máximo 50 preferred phrases').optional(),
  emotions_to_evoke: z.array(z.string().min(2, 'Cada emotion debe tener al menos 2 caracteres')).max(15, 'Máximo 15 emotions').optional(),
  
  // Brand guidelines additional
  logo_usage: z.string().min(10, 'Logo usage debe tener al menos 10 caracteres').max(500, 'Logo usage no puede exceder 500 caracteres').optional(),
  color_usage: z.string().min(10, 'Color usage debe tener al menos 10 caracteres').max(500, 'Color usage no puede exceder 500 caracteres').optional(),
  imagery_style: z.string().min(10, 'Imagery style debe tener al menos 10 caracteres').max(500, 'Imagery style no puede exceder 500 caracteres').optional(),
  typography_usage: z.string().min(10, 'Typography usage debe tener al menos 10 caracteres').max(500, 'Typography usage no puede exceder 500 caracteres').optional(),
  messaging_guidelines: z.string().min(10, 'Messaging guidelines debe tener al menos 10 caracteres').max(500, 'Messaging guidelines no puede exceder 500 caracteres').optional(),
  
  // Brand assets
  logo_variations: z.array(z.string().min(3, 'Cada logo variation debe tener al menos 3 caracteres')).max(10, 'Máximo 10 logo variations').optional(),
  templates: z.array(z.string().min(3, 'Cada template debe tener al menos 3 caracteres')).max(20, 'Máximo 20 templates').optional(),
  font_files: z.array(z.string().min(3, 'Cada font file debe tener al menos 3 caracteres')).max(20, 'Máximo 20 font files').optional(),
  color_swatches: z.array(z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Cada color swatch debe ser un código hex válido')).max(20, 'Máximo 20 color swatches').optional(),
  
  // Neutral colors
  neutral_colors: z.array(z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Cada neutral color debe ser un código hex válido')).max(10, 'Máximo 10 neutral colors').optional()
}).strict()

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
    console.log(`🔧 [UX Analysis] Opciones:`, options)

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
    console.log(`⚙️ [UX Analysis] Configuración del análisis:`, analysisOptions)

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

    console.log(`🎯 [UX Analysis] Deliverables finales a enviar a análisis:`, finalDeliverables)

    // Realizar análisis estructurado del sitio con HTML y screenshot
    console.log(`🚀 [UX Analysis] Iniciando análisis estructurado con prompt simplificado...`)
    console.log(`📊 [UX Analysis] Proveedor: ${analysisOptions.provider}, Modelo: ${analysisOptions.modelId}`)
    
    const structuredAnalysis = await performStructuredAnalysis(siteInfo.site.url, {
      ...analysisOptions,
      htmlContent,
      screenshot,
      deliverables: finalDeliverables
    })

    if (!structuredAnalysis) {
      throw new Error('Error en análisis estructurado: No se pudo obtener resultado del análisis')
    }

    console.log(`🎉 [UX Analysis] Análisis estructurado completado exitosamente`)
    console.log(`📈 [UX Analysis] Estructura del análisis:`, {
      site_info: structuredAnalysis.site_info ? 'Presente' : 'Ausente',
      blocks: structuredAnalysis.blocks ? `${structuredAnalysis.blocks.length} bloques` : 'Ausente',
      structure_analysis: structuredAnalysis.structure_analysis ? 'Presente' : 'Ausente',
      branding_analysis: structuredAnalysis.branding_analysis ? 'Presente' : 'Ausente',
      ux_assessment: structuredAnalysis.ux_assessment ? 'Presente' : 'Ausente',
      recommendations: structuredAnalysis.recommendations ? `${structuredAnalysis.recommendations.length} recomendaciones` : 'Ausente',
      problems: structuredAnalysis.problems ? `${structuredAnalysis.problems.length} problemas` : 'Ausente',
      opportunities: structuredAnalysis.opportunities ? `${structuredAnalysis.opportunities.length} oportunidades` : 'Ausente'
    })

    // Debugging: Ver qué deliverables se generaron realmente
    console.log(`🔍 [UX Analysis] Deliverables generados:`)
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
      const extractedBranding = await extractBrandingFromAnalysis(structuredAnalysis, siteInfo, options?.language || 'es')
      if (extractedBranding) {
        responseData.branding = extractedBranding
        console.log(`✅ [UX Analysis] Branding extraído correctamente con ${Object.keys(extractedBranding).length} campos`)
      } else {
        console.log(`ℹ️ [UX Analysis] No se extrajo branding - no hay datos suficientes en el análisis`)
      }
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
    const analysisStructure: any = {
      original_analysis: structuredAnalysis,
      ux_assessment: responseData.ux_assessment,
      recommendations: responseData.recommendations,
      problems: responseData.problems,
      opportunities: responseData.opportunities,
      processing_time: processingTime,
      analysis_type: 'ux_analysis'
    }

    // Solo incluir branding_analysis si hay datos reales
    if (responseData.branding && Object.keys(responseData.branding).length > 0) {
      analysisStructure.branding_analysis = responseData.branding
      console.log(`📝 [UX Analysis] Incluyendo branding_analysis en la base de datos con ${Object.keys(responseData.branding).length} campos`)
    } else {
      console.log(`📝 [UX Analysis] No se incluye branding_analysis en la base de datos - no hay datos suficientes`)
    }

    const analysisData = {
      site_id,
      url_path: siteInfo.site.url,
      structure: analysisStructure,
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
    if (responseData.branding && Object.keys(responseData.branding).length > 0 && siteInfo.settings !== undefined) {
      try {
        await updateSiteBranding(site_id, responseData.branding, siteInfo.settings?.branding)
        console.log(`✅ [UX Analysis] Branding actualizado en settings para sitio: ${site_id}`)
      } catch (error) {
        console.error(`❌ [UX Analysis] Error actualizando branding en settings: ${error}`)
        // No falla la petición completa, solo log el error
      }
    } else if (responseData.branding && Object.keys(responseData.branding).length > 0 && siteInfo.settings === undefined) {
      console.warn(`⚠️ [UX Analysis] No se encontró settings para actualizar branding en sitio: ${site_id}`)
    } else if (!responseData.branding || Object.keys(responseData.branding).length === 0) {
      console.log(`ℹ️ [UX Analysis] No hay datos de branding para actualizar en settings`)
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
    
    // Mejores detalles del error para debugging
    if (error instanceof z.ZodError) {
      errorMessage = error.errors[0].message
      errorType = 'VALIDATION_ERROR'
      status = 400
      console.error('❌ [UX Analysis] Error de validación:', error.errors)
    } else if (error instanceof Error) {
      errorMessage = error.message
      console.error('❌ [UX Analysis] Error detallado:', {
        name: error.name,
        message: error.message,
        stack: error.stack?.split('\n').slice(0, 5).join('\n') // Primeras 5 líneas del stack
      })
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
    
    // Estructura plana como se usa en la base de datos - SOLO campos que realmente existen
    const flatBranding: any = {}
    
    // Brand pyramid fields (flat) - solo si existen
    if (brandingAnalysis.brand_pyramid?.brand_essence) {
      flatBranding.brand_essence = brandingAnalysis.brand_pyramid.brand_essence
    }
    if (brandingAnalysis.brand_pyramid?.brand_personality) {
      flatBranding.brand_personality = brandingAnalysis.brand_pyramid.brand_personality
    }
    if (brandingAnalysis.brand_pyramid?.brand_benefits) {
      flatBranding.brand_benefits = brandingAnalysis.brand_pyramid.brand_benefits
    }
    if (brandingAnalysis.brand_pyramid?.brand_attributes) {
      flatBranding.brand_attributes = brandingAnalysis.brand_pyramid.brand_attributes
    }
    if (brandingAnalysis.brand_pyramid?.brand_values) {
      flatBranding.brand_values = brandingAnalysis.brand_pyramid.brand_values
    }
    if (brandingAnalysis.brand_pyramid?.brand_promise) {
      flatBranding.brand_promise = brandingAnalysis.brand_pyramid.brand_promise
    }
    
    // Brand archetype (flat) - solo si existe y es válido
    if (brandingAnalysis.brand_archetype) {
      const archetypeValue = extractArchetypeValue(brandingAnalysis.brand_archetype)
      if (archetypeValue !== 'sage' || brandingAnalysis.brand_archetype.toLowerCase().includes('sage')) {
        flatBranding.brand_archetype = archetypeValue
      }
    }
    
    // Color palette (flat) - solo colores que realmente existen
    if (brandingAnalysis.color_palette?.primary_color) {
      flatBranding.primary_color = brandingAnalysis.color_palette.primary_color
    }
    if (brandingAnalysis.color_palette?.secondary_color) {
      flatBranding.secondary_color = brandingAnalysis.color_palette.secondary_color
    }
    if (brandingAnalysis.color_palette?.accent_color) {
      flatBranding.accent_color = brandingAnalysis.color_palette.accent_color
    }
    // No incluir success_color, warning_color, etc. a menos que vengan del análisis
    
    // Typography (flat) - solo si existe
    if (brandingAnalysis.typography?.primary_font) {
      flatBranding.primary_font = brandingAnalysis.typography.primary_font
    }
    if (brandingAnalysis.typography?.secondary_font) {
      flatBranding.secondary_font = brandingAnalysis.typography.secondary_font
    }
    if (brandingAnalysis.typography?.font_hierarchy) {
      flatBranding.font_hierarchy = brandingAnalysis.typography.font_hierarchy
    }
    if (brandingAnalysis.typography?.font_sizes) {
      flatBranding.font_sizes = brandingAnalysis.typography.font_sizes
    }
    
    // Voice and tone (flat) - solo si existe
    if (brandingAnalysis.voice_and_tone?.communication_style) {
      flatBranding.communication_style = brandingAnalysis.voice_and_tone.communication_style
    }
    if (brandingAnalysis.voice_and_tone?.personality_traits && Array.isArray(brandingAnalysis.voice_and_tone.personality_traits) && brandingAnalysis.voice_and_tone.personality_traits.length > 0) {
      flatBranding.personality_traits = brandingAnalysis.voice_and_tone.personality_traits
    }
    if (brandingAnalysis.voice_and_tone?.brand_voice) {
      flatBranding.brand_voice = brandingAnalysis.voice_and_tone.brand_voice
    }
    
    // Brand guidelines (flat) - solo si existen arrays con contenido
    if (brandingAnalysis.voice_and_tone?.do_and_dont?.do && Array.isArray(brandingAnalysis.voice_and_tone.do_and_dont.do) && brandingAnalysis.voice_and_tone.do_and_dont.do.length > 0) {
      flatBranding.do_list = brandingAnalysis.voice_and_tone.do_and_dont.do
      flatBranding.preferred_phrases = brandingAnalysis.voice_and_tone.do_and_dont.do
    }
    if (brandingAnalysis.voice_and_tone?.do_and_dont?.dont && Array.isArray(brandingAnalysis.voice_and_tone.do_and_dont.dont) && brandingAnalysis.voice_and_tone.do_and_dont.dont.length > 0) {
      flatBranding.dont_list = brandingAnalysis.voice_and_tone.do_and_dont.dont
      flatBranding.forbidden_words = brandingAnalysis.voice_and_tone.do_and_dont.dont
    }
    
    // Brand guidelines additional (flat) - solo si existen
    if (brandingAnalysis.brand_guidelines?.logo_usage) {
      flatBranding.logo_usage = brandingAnalysis.brand_guidelines.logo_usage
    }
    if (brandingAnalysis.brand_guidelines?.color_usage) {
      flatBranding.color_usage = brandingAnalysis.brand_guidelines.color_usage
    }
    if (brandingAnalysis.brand_guidelines?.imagery_style) {
      flatBranding.imagery_style = brandingAnalysis.brand_guidelines.imagery_style
    }
    if (brandingAnalysis.brand_guidelines?.typography_usage) {
      flatBranding.typography_usage = brandingAnalysis.brand_guidelines.typography_usage
    }
    if (brandingAnalysis.brand_guidelines?.messaging_guidelines) {
      flatBranding.messaging_guidelines = brandingAnalysis.brand_guidelines.messaging_guidelines
    }
    
    // Brand assets (flat) - solo si existen arrays con contenido
    if (brandingAnalysis.brand_assets?.logo_variations && Array.isArray(brandingAnalysis.brand_assets.logo_variations) && brandingAnalysis.brand_assets.logo_variations.length > 0) {
      flatBranding.logo_variations = brandingAnalysis.brand_assets.logo_variations
    }
    if (brandingAnalysis.brand_assets?.templates && Array.isArray(brandingAnalysis.brand_assets.templates) && brandingAnalysis.brand_assets.templates.length > 0) {
      flatBranding.templates = brandingAnalysis.brand_assets.templates
    }
    if (brandingAnalysis.brand_assets?.font_files && Array.isArray(brandingAnalysis.brand_assets.font_files) && brandingAnalysis.brand_assets.font_files.length > 0) {
      flatBranding.font_files = brandingAnalysis.brand_assets.font_files
    }
    if (brandingAnalysis.brand_assets?.color_swatches && Array.isArray(brandingAnalysis.brand_assets.color_swatches) && brandingAnalysis.brand_assets.color_swatches.length > 0) {
      flatBranding.color_swatches = brandingAnalysis.brand_assets.color_swatches
    }
    
    // Neutral colors (flat) - solo si existen
    if (brandingAnalysis.color_palette?.neutral_colors && Array.isArray(brandingAnalysis.color_palette.neutral_colors) && brandingAnalysis.color_palette.neutral_colors.length > 0) {
      flatBranding.neutral_colors = brandingAnalysis.color_palette.neutral_colors
    }
    
    // Solo devolver branding si tenemos al menos algunos campos significativos
    const significantFields = ['brand_essence', 'brand_personality', 'brand_archetype', 'primary_color', 'communication_style']
    const hasSignificantData = significantFields.some(field => flatBranding[field])
    
    if (!hasSignificantData) {
      console.log(`⚠️ [UX Analysis] No hay datos significativos de branding en el análisis estructurado`)
      return null
    }
    
    console.log(`✅ [UX Analysis] Branding extraído y mapeado a estructura plana:`, {
      fields_found: Object.keys(flatBranding).length,
      significant_fields: significantFields.filter(field => flatBranding[field]).length,
      sample_fields: Object.keys(flatBranding).slice(0, 5)
    })
    
    return flatBranding
  }
  
  // Si no hay branding_analysis, intentar extraer información básica del análisis estructurado
  console.log(`⚠️ [UX Analysis] No hay branding_analysis en el análisis estructurado, intentando extraer datos básicos`)
  
  const siteStructure = analysis.structure || {}
  const visualElements = siteStructure.visual_elements || {}
  const content = siteStructure.content || {}
  
  const extractedBranding: any = {}
  
  // Solo extraer datos si realmente existen y son significativos
  if (content?.brand_essence || content?.value_proposition) {
    extractedBranding.brand_essence = content.brand_essence || content.value_proposition
  }
  
  if (content?.benefits && content.benefits !== 'Beneficios extraídos del análisis') {
    extractedBranding.brand_benefits = content.benefits
  }
  
  if (visualElements?.colors && Array.isArray(visualElements.colors) && visualElements.colors.length > 0) {
    if (visualElements.colors[0] && visualElements.colors[0] !== '#2563eb') {
      extractedBranding.primary_color = visualElements.colors[0]
    }
    if (visualElements.colors[1] && visualElements.colors[1] !== '#1e293b') {
      extractedBranding.secondary_color = visualElements.colors[1]
    }
    if (visualElements.colors[2] && visualElements.colors[2] !== '#6366f1') {
      extractedBranding.accent_color = visualElements.colors[2]
    }
  }
  
  if (visualElements?.fonts && Array.isArray(visualElements.fonts) && visualElements.fonts.length > 0) {
    if (visualElements.fonts[0] && visualElements.fonts[0] !== 'Inter, sans-serif') {
      extractedBranding.primary_font = visualElements.fonts[0]
    }
    if (visualElements.fonts[1] && visualElements.fonts[1] !== 'system-ui, sans-serif') {
      extractedBranding.secondary_font = visualElements.fonts[1]
    }
  }
  
  // Solo extraer communication_style si hay evidencia real
  if (content?.tone && content.tone !== 'neutral' && content.tone !== 'friendly') {
    const inferredStyle = inferCommunicationStyle(content)
    if (inferredStyle !== 'friendly') {
      extractedBranding.communication_style = inferredStyle
    }
  }
  
  // Solo devolver si tenemos al menos 2 campos reales
  if (Object.keys(extractedBranding).length < 2) {
    console.log(`⚠️ [UX Analysis] No hay suficientes datos reales de branding para extraer (${Object.keys(extractedBranding).length} campos)`)
    return null
  }
  
  console.log(`✅ [UX Analysis] Branding básico extraído:`, {
    fields_found: Object.keys(extractedBranding).length,
    fields: Object.keys(extractedBranding)
  })
  
  return extractedBranding
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

// Función para validar campos de branding
function validateBrandingFields(brandingData: any): { 
  isValid: boolean; 
  validatedData: any; 
  errors: string[]; 
  validFields: number 
} {
  const errors: string[] = []
  const validatedData: any = {}
  
  try {
    // Validar todo el objeto con el esquema completo
    const result = BrandingSchema.safeParse(brandingData)
    
    if (result.success) {
      // Si toda la validación es exitosa, usar los datos validados
      return {
        isValid: true,
        validatedData: result.data,
        errors: [],
        validFields: Object.keys(result.data).length
      }
    } else {
      // Si hay errores, procesar campo por campo para obtener los válidos
      const fieldErrors = result.error.errors.map(e => `${e.path.join('.')}: ${e.message}`)
      errors.push(...fieldErrors)
      
      // Extraer campos válidos individualmente
      for (const [key, value] of Object.entries(brandingData)) {
        if (value === null || value === undefined || value === '') {
          continue
        }
        
        try {
          // Crear un objeto temporal solo con este campo para validar
          const tempObject = { [key]: value }
          const fieldResult = BrandingSchema.safeParse(tempObject)
          
          if (fieldResult.success && fieldResult.data[key as keyof typeof fieldResult.data]) {
            validatedData[key] = fieldResult.data[key as keyof typeof fieldResult.data]
          }
        } catch (fieldError) {
          // Error individual del campo ya capturado en el error general
          continue
        }
      }
      
      return {
        isValid: false,
        validatedData,
        errors,
        validFields: Object.keys(validatedData).length
      }
    }
  } catch (error) {
    return {
      isValid: false,
      validatedData: {},
      errors: ['Error de validación general: ' + (error instanceof Error ? error.message : 'Error desconocido')],
      validFields: 0
    }
  }
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
    
    // Validar campos de branding antes de procesar
    console.log(`🔍 [UX Analysis] Validando campos de branding...`)
    const validationResult = validateBrandingFields(newBrandingData)
    
    if (!validationResult.isValid) {
      console.error('❌ [UX Analysis] Errores de validación en branding:', validationResult.errors)
      throw new Error(`Errores de validación en branding: ${validationResult.errors.join(', ')}`)
    }
    
    console.log(`✅ [UX Analysis] Validación de branding exitosa. Campos válidos: ${validationResult.validFields}`)
    
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
    const mergedBranding = fillMissingFields(existingBranding, validationResult.validatedData)
    
    // Contar campos que se van a actualizar
    const fieldsToUpdate = countFieldsToUpdate(existingBranding, validationResult.validatedData)
    console.log(`🔄 [UX Analysis] Actualizando ${fieldsToUpdate} campos de branding faltantes`)
    console.log(`🔍 [UX Analysis] Campos validados y nuevos de branding:`, Object.keys(validationResult.validatedData))
    
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
      sample_fields: Object.keys(mergedBranding).slice(0, 5),
      validation_errors_filtered: validationResult.errors.length
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
      'El branding solo se incluye y actualiza si hay datos reales extraídos del análisis',
      'No se generan valores por defecto - solo se guardan datos que realmente existen',
      'Solo se actualizan campos de branding que estén vacíos o no existan en la base de datos',
      'El proceso no sobrescribe información existente, solo completa campos faltantes con datos reales'
    ]
  })
} 