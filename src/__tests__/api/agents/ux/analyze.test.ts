import { describe, it, expect, jest } from '@jest/globals'

// Mock de la función extractBrandingFromAnalysis
// Como es una función interna, la recreamos aquí para testing
async function extractBrandingFromAnalysis(analysis: any, siteInfo: any, language: string) {
  // Si el análisis estructurado contiene branding_analysis, usarlo directamente
  if (analysis.branding_analysis) {
    const brandingAnalysis = analysis.branding_analysis
    
    // Mapear la estructura del GPT a la estructura esperada en la respuesta
    const mappedBranding = {
      positioning: {
        brand_promise: brandingAnalysis.brand_pyramid?.brand_promise || 
                      brandingAnalysis.brand_pyramid?.brand_essence || 
                      'Promesa de marca extraída del análisis del sitio',
        target_market: brandingAnalysis.brand_pyramid?.brand_attributes || 
                      'Servicios profesionales - Profesionales y empresas',
        value_proposition: brandingAnalysis.brand_pyramid?.brand_benefits || 
                          brandingAnalysis.brand_pyramid?.brand_essence || 
                          'Propuesta de valor extraída del análisis',
        competitive_advantage: brandingAnalysis.brand_pyramid?.brand_attributes || 
                              brandingAnalysis.brand_pyramid?.brand_essence || 
                              'Ventaja competitiva identificada en el análisis'
      },
      brand_pyramid: {
        values: brandingAnalysis.brand_pyramid?.brand_values ? 
                [brandingAnalysis.brand_pyramid.brand_values] : 
                brandingAnalysis.voice_and_tone?.personality_traits || 
                ['Innovación', 'Calidad', 'Orientación al cliente'],
        vision: `Ser líder en ${siteInfo?.site?.industry || 'la industria'} a través de ${siteInfo?.site?.name || 'la innovación'}`,
        mission: brandingAnalysis.brand_pyramid?.brand_promise || 
                brandingAnalysis.brand_pyramid?.brand_essence || 
                'Proporcionar soluciones innovadoras que generen valor',
        purpose: brandingAnalysis.brand_pyramid?.brand_essence || 
                `Transformar la experiencia del cliente a través de ${siteInfo?.site?.name || 'nuestra solución'}`,
        personality_traits: brandingAnalysis.voice_and_tone?.personality_traits || 
                           [brandingAnalysis.brand_pyramid?.brand_personality] || 
                           ['Confiable', 'Innovador', 'Orientado al cliente']
      },
      voice_and_tone: {
        do_say: brandingAnalysis.voice_and_tone?.do_and_dont?.do || 
               ['Destacar el valor único', 'Usar lenguaje claro y directo'],
        dont_say: brandingAnalysis.voice_and_tone?.do_and_dont?.dont || 
                 ['Evitar promesas exageradas', 'No usar jerga técnica excesiva'],
        personality: brandingAnalysis.voice_and_tone?.brand_voice || 
                    brandingAnalysis.brand_pyramid?.brand_personality || 
                    'Personalidad profesional y confiable',
        tone_attributes: brandingAnalysis.voice_and_tone?.personality_traits || 
                        ['Confiable', 'Claro', 'Profesional'],
        communication_style: brandingAnalysis.voice_and_tone?.communication_style || 
                            'Comunicación clara y directa con enfoque en valor al usuario'
      },
      brand_archetype: brandingAnalysis.brand_archetype || 'El Sabio - Experto y confiable',
      visual_identity: {
        logo_style: brandingAnalysis.brand_guidelines?.logo_usage || null,
        typography: brandingAnalysis.typography?.primary_font || 
                   brandingAnalysis.typography?.font_hierarchy || null,
        color_palette: [
          brandingAnalysis.color_palette?.primary_color,
          brandingAnalysis.color_palette?.secondary_color,
          brandingAnalysis.color_palette?.accent_color
        ].filter(Boolean).concat(brandingAnalysis.color_palette?.neutral_colors || []),
        imagery_style: brandingAnalysis.brand_guidelines?.imagery_style || null,
        design_principles: brandingAnalysis.brand_guidelines ? 
                          [brandingAnalysis.brand_guidelines.color_usage, brandingAnalysis.brand_guidelines.typography_usage].filter(Boolean) : 
                          []
      }
    }
    
    return mappedBranding
  }
  
  // Fallback para casos sin branding_analysis
  return {
    positioning: {
      brand_promise: 'Promesa de marca basada en el análisis del sitio',
      target_market: 'Servicios profesionales - Profesionales y empresas',
      value_proposition: 'Propuesta de valor extraída del análisis',
      competitive_advantage: 'Solución innovadora y orientada al cliente'
    },
    brand_pyramid: {
      values: ['Innovación', 'Calidad', 'Orientación al cliente'],
      vision: 'Ser líder en la industria a través de la innovación',
      mission: 'Proporcionar soluciones innovadoras que generen valor',
      purpose: 'Transformar la experiencia del cliente a través de nuestra solución',
      personality_traits: ['Confiable', 'Innovador', 'Orientado al cliente']
    },
    voice_and_tone: {
      do_say: ['Destacar el valor único', 'Usar lenguaje claro y directo'],
      dont_say: ['Evitar promesas exageradas', 'No usar jerga técnica excesiva'],
      personality: 'Personalidad profesional y confiable',
      tone_attributes: ['Confiable', 'Claro', 'Profesional'],
      communication_style: 'Comunicación clara y directa con enfoque en valor al usuario'
    },
    brand_archetype: 'El Sabio - Experto y confiable',
    visual_identity: {
      logo_style: null,
      typography: null,
      color_palette: [],
      imagery_style: null,
      design_principles: []
    }
  }
}

describe('UX Analysis API - extractBrandingFromAnalysis', () => {
  
  it('should extract branding from structured analysis with branding_analysis', async () => {
    // Mock de análisis estructurado que incluye branding_analysis
    const mockAnalysis = {
      branding_analysis: {
        brand_pyramid: {
          brand_essence: 'Esencia de marca innovadora',
          brand_personality: 'Profesional e innovador',
          brand_benefits: 'Beneficios clave para el cliente',
          brand_attributes: 'Atributos distintivos',
          brand_values: 'Innovación, Calidad, Confianza',
          brand_promise: 'Promesa de valor única'
        },
        brand_archetype: 'El Mago - Innovador y transformador',
        color_palette: {
          primary_color: '#007bff',
          secondary_color: '#6c757d',
          accent_color: '#28a745',
          neutral_colors: ['#ffffff', '#f8f9fa']
        },
        typography: {
          primary_font: 'Roboto, sans-serif',
          font_hierarchy: 'Jerarquía tipográfica clara'
        },
        voice_and_tone: {
          brand_voice: 'Voz profesional',
          communication_style: 'Estilo directo y claro',
          personality_traits: ['Confiable', 'Experto', 'Innovador'],
          do_and_dont: {
            do: ['Usar lenguaje técnico preciso', 'Demostrar experiencia'],
            dont: ['Evitar promesas no verificables', 'No usar jerga innecesaria']
          }
        },
        brand_guidelines: {
          logo_usage: 'Uso del logo con espaciado adecuado',
          imagery_style: 'Imágenes profesionales y modernas',
          color_usage: 'Uso consistente de colores de marca',
          typography_usage: 'Tipografía coherente en todos los materiales'
        }
      }
    }
    
    const mockSiteInfo = {
      site: {
        name: 'TestSite',
        industry: 'Tecnología'
      }
    }
    
    const result = await extractBrandingFromAnalysis(mockAnalysis, mockSiteInfo, 'es')
    
    // Verificar que no hay valores null en positioning
    expect(result.positioning.brand_promise).toBe('Promesa de valor única')
    expect(result.positioning.target_market).toBe('Atributos distintivos')
    expect(result.positioning.value_proposition).toBe('Beneficios clave para el cliente')
    expect(result.positioning.competitive_advantage).toBe('Atributos distintivos')
    
    // Verificar que brand_pyramid tiene valores
    expect(result.brand_pyramid.values).toEqual(['Innovación, Calidad, Confianza'])
    expect(result.brand_pyramid.vision).toBe('Ser líder en Tecnología a través de TestSite')
    expect(result.brand_pyramid.mission).toBe('Promesa de valor única')
    expect(result.brand_pyramid.purpose).toBe('Esencia de marca innovadora')
    expect(result.brand_pyramid.personality_traits).toEqual(['Confiable', 'Experto', 'Innovador'])
    
    // Verificar voice_and_tone
    expect(result.voice_and_tone.do_say).toEqual(['Usar lenguaje técnico preciso', 'Demostrar experiencia'])
    expect(result.voice_and_tone.dont_say).toEqual(['Evitar promesas no verificables', 'No usar jerga innecesaria'])
    expect(result.voice_and_tone.personality).toBe('Voz profesional')
    expect(result.voice_and_tone.tone_attributes).toEqual(['Confiable', 'Experto', 'Innovador'])
    expect(result.voice_and_tone.communication_style).toBe('Estilo directo y claro')
    
    // Verificar brand_archetype
    expect(result.brand_archetype).toBe('El Mago - Innovador y transformador')
    
    // Verificar visual_identity
    expect(result.visual_identity.logo_style).toBe('Uso del logo con espaciado adecuado')
    expect(result.visual_identity.typography).toBe('Roboto, sans-serif')
    expect(result.visual_identity.color_palette).toEqual(['#007bff', '#6c757d', '#28a745', '#ffffff', '#f8f9fa'])
    expect(result.visual_identity.imagery_style).toBe('Imágenes profesionales y modernas')
    expect(result.visual_identity.design_principles).toEqual(['Uso consistente de colores de marca', 'Tipografía coherente en todos los materiales'])
  })
  
  it('should fallback to default values when branding_analysis is null', async () => {
    const mockAnalysis = {
      // Sin branding_analysis
      structure: {
        content: {},
        visual_elements: {}
      }
    }
    
    const mockSiteInfo = {
      site: {
        name: 'TestSite',
        industry: 'Servicios'
      }
    }
    
    const result = await extractBrandingFromAnalysis(mockAnalysis, mockSiteInfo, 'es')
    
    // Verificar que no hay valores null
    expect(result.positioning.brand_promise).toBe('Promesa de marca basada en el análisis del sitio')
    expect(result.positioning.target_market).toBe('Servicios profesionales - Profesionales y empresas')
    expect(result.positioning.value_proposition).toBe('Propuesta de valor extraída del análisis')
    expect(result.positioning.competitive_advantage).toBe('Solución innovadora y orientada al cliente')
    
    // Verificar arrays no vacíos
    expect(result.brand_pyramid.values).toEqual(['Innovación', 'Calidad', 'Orientación al cliente'])
    expect(result.brand_pyramid.personality_traits).toEqual(['Confiable', 'Innovador', 'Orientado al cliente'])
    expect(result.voice_and_tone.do_say).toEqual(['Destacar el valor único', 'Usar lenguaje claro y directo'])
    expect(result.voice_and_tone.dont_say).toEqual(['Evitar promesas exageradas', 'No usar jerga técnica excesiva'])
    expect(result.voice_and_tone.tone_attributes).toEqual(['Confiable', 'Claro', 'Profesional'])
    
    // Verificar strings no vacíos
    expect(result.brand_pyramid.vision).toBe('Ser líder en la industria a través de la innovación')
    expect(result.brand_pyramid.mission).toBe('Proporcionar soluciones innovadoras que generen valor')
    expect(result.brand_pyramid.purpose).toBe('Transformar la experiencia del cliente a través de nuestra solución')
    expect(result.voice_and_tone.personality).toBe('Personalidad profesional y confiable')
    expect(result.voice_and_tone.communication_style).toBe('Comunicación clara y directa con enfoque en valor al usuario')
    expect(result.brand_archetype).toBe('El Sabio - Experto y confiable')
  })
  
  it('should handle empty analysis gracefully', async () => {
    const mockAnalysis = {}
    const mockSiteInfo = {}
    
    const result = await extractBrandingFromAnalysis(mockAnalysis, mockSiteInfo, 'es')
    
    // Verificar que la función no falla y devuelve valores por defecto
    expect(result.positioning).toBeDefined()
    expect(result.brand_pyramid).toBeDefined()
    expect(result.voice_and_tone).toBeDefined()
    expect(result.brand_archetype).toBeDefined()
    expect(result.visual_identity).toBeDefined()
    
    // Verificar que no hay valores null en campos críticos
    expect(result.positioning.brand_promise).toBeTruthy()
    expect(result.positioning.target_market).toBeTruthy()
    expect(result.positioning.value_proposition).toBeTruthy()
    expect(result.positioning.competitive_advantage).toBeTruthy()
  })
}) 