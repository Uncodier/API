/**
 * BackgroundBuilder.ts
 * Clase para construir el texto de background del agente de manera estructurada
 */

import { z } from 'zod';

// Esquema base para direcciones/locaciones (estructura común)
const BaseLocationSchema = z.object({
  zip: z.string().optional(),
  city: z.string().optional(),
  name: z.string().optional(),
  state: z.string().optional(),
  address: z.string().optional(),
  country: z.string().optional(),
});

// Esquema de validación para el objeto restrictions
// Las direcciones excluidas/incluidas usan la misma estructura que las locaciones principales
const RestrictionsSchema = z.object({
  enabled: z.boolean().default(false),
  excluded_addresses: z.array(BaseLocationSchema).default([]),
  included_addresses: z.array(BaseLocationSchema).default([]),
});

// Función para limpiar y formatear ubicaciones
function formatLocations(locations: any[]): any[] {
  return locations.map(location => {
    // Función helper para limpiar objetos de valores vacíos
    const cleanObject = (obj: any) => {
      const cleaned: any = {};
      Object.keys(obj).forEach(key => {
        const value = obj[key];
        if (value !== null && value !== undefined && value !== '') {
          if (Array.isArray(value)) {
            const cleanedArray = value.map(item => cleanObject(item)).filter(item => Object.keys(item).length > 0);
            if (cleanedArray.length > 0) {
              cleaned[key] = cleanedArray;
            }
          } else if (typeof value === 'object') {
            const cleanedNestedObj = cleanObject(value);
            if (Object.keys(cleanedNestedObj).length > 0) {
              cleaned[key] = cleanedNestedObj;
            }
          } else {
            cleaned[key] = value;
          }
        }
      });
      return cleaned;
    };

    // Limpiar la ubicación principal
    const cleanedLocation = cleanObject(location);
    
    // Procesar restricciones con nueva nomenclatura
    if (cleanedLocation.restrictions) {
      const restrictions = cleanedLocation.restrictions;
      const newRestrictions: any = {
        enabled: restrictions.enabled
      };

      // Cambiar nomenclatura y limpiar arrays
      if (restrictions.included_addresses && restrictions.included_addresses.length > 0) {
        const cleanedIncluded = restrictions.included_addresses.map((addr: any) => cleanObject(addr)).filter((addr: any) => Object.keys(addr).length > 0);
        if (cleanedIncluded.length > 0) {
          newRestrictions.service_only_available_in = cleanedIncluded;
        }
      }

      if (restrictions.excluded_addresses && restrictions.excluded_addresses.length > 0) {
        const cleanedExcluded = restrictions.excluded_addresses.map((addr: any) => cleanObject(addr)).filter((addr: any) => Object.keys(addr).length > 0);
        if (cleanedExcluded.length > 0) {
          newRestrictions.service_excluded_in = cleanedExcluded;
        }
      }

      // Solo agregar restrictions si tiene contenido útil
      if (Object.keys(newRestrictions).length > 1) { // más que solo 'enabled'
        cleanedLocation.restrictions = newRestrictions;
      } else {
        delete cleanedLocation.restrictions;
      }
    }

    return cleanedLocation;
  });
}

// Esquema de validación para cada location (extiende la estructura base + restrictions)
const LocationSchema = BaseLocationSchema.extend({
  restrictions: RestrictionsSchema.optional(),
});

export class BackgroundBuilder {
  /**
   * Construye el prompt del agente incorporando todas las fuentes de información disponibles
   */
  public static buildAgentPrompt(
    id: string,
    name: string,
    description: string,
    capabilities: string[],
    backstory?: string,
    systemPrompt?: string,
    agentPrompt?: string,
    siteInfo?: {
      site: any | null;
      settings: any | null;
      copywriting?: any[] | null;
    },
    activeCampaigns?: Array<{
      title: string;
      description?: string;
    }>
  ): string {
    // Reduced verbosity - only log essentials
    console.log(`🧩 [BackgroundBuilder] Building prompt for ${name}`);
    
    // Reduced verbosity - branding check removed
    
    // Construir el prompt de forma estructurada por bloques
    const sections = [
      this.createServerDateSection(),
      this.createIdentitySection(id, name),
      this.createBackstorySection(backstory),
      this.createDescriptionSection(description),
      this.createCapabilitiesSection(capabilities),
      this.createInstructionsSection(name),
      this.createSystemSection(systemPrompt),
      this.createCustomInstructionsSection(agentPrompt),
      // No incluimos siteInfo si es null o todos los campos son null/vacíos
      (!siteInfo || (!siteInfo.site && !siteInfo.settings && (!siteInfo.copywriting || siteInfo.copywriting.length === 0))) ? '' : this.createSiteInfoSection(siteInfo),
      // Incluir campañas activas si están disponibles
      (!activeCampaigns || activeCampaigns.length === 0) ? '' : this.createActiveCampaignsSection(activeCampaigns)
    ];
    
    // Unir todas las secciones, filtrando las vacías
    const finalPrompt = sections
      .filter(section => section.trim() !== '')
      .join('\n\n');
    
    // Reduced verbosity
    
    // Verificaciones de control
    this.verifyPromptSections(finalPrompt, systemPrompt, agentPrompt, backstory, siteInfo);
    
    return finalPrompt;
  }
  
  /**
   * Crea la sección con la fecha del servidor
   */
  private static createServerDateSection(): string {
    const serverDate = new Date().toISOString();
    return `# Current Server Date & Time\nServer UTC: ${serverDate}`;
  }
  
  /**
   * Crea la sección de identidad del agente
   */
  private static createIdentitySection(id: string, name: string): string {
    return `# Agent Identity\nYou are ${name} (ID: ${id}).`;
  }
  
  /**
   * Crea la sección de backstory si está disponible
   */
  private static createBackstorySection(backstory?: string): string {
    if (!backstory || !backstory.trim()) return '';
    
    // Reduced verbosity
    return `# Backstory\n${backstory}`;
  }
  
  /**
   * Crea la sección de información del sitio si está disponible
   */
  private static createSiteInfoSection(siteInfo?: { site: any | null; settings: any | null; copywriting?: any[] | null }): string {
    if (!siteInfo || (!siteInfo.site && !siteInfo.settings && (!siteInfo.copywriting || siteInfo.copywriting.length === 0))) return '';
    
    // Reduced verbosity
    let siteSection = '# Site Information\n';
    
    // Añadir información básica del sitio
    if (siteInfo.site) {
      // Reduced verbosity
      
      siteSection += `## Site Details\n`;
      siteSection += `Name: ${siteInfo.site.name || 'Not specified'}\n`;
      siteSection += `URL: ${siteInfo.site.url || 'Not specified'}\n`;
      siteSection += `Description: ${siteInfo.site.description || 'Not specified'}\n`;
      
      // Agregar recursos del sitio si existen con una explicación
      if (siteInfo.site.resource_urls && Object.keys(siteInfo.site.resource_urls).length > 0) {
        siteSection += `\n## Important External URL Resources\n`;
        siteSection += `These are key external resources relevant to the site that can provide additional context and information:\n`;
        siteSection += `${JSON.stringify(siteInfo.site.resource_urls)}\n`;
      }
      
      // Agregar horarios de atención si están disponibles (desde site)
      if (siteInfo.site.business_hours && Object.keys(siteInfo.site.business_hours).length > 0) {
        // Reduced verbosity
        siteSection += `\n## Business Hours\n`;
        try {
          const businessHours = typeof siteInfo.site.business_hours === 'string'
            ? JSON.parse(siteInfo.site.business_hours)
            : siteInfo.site.business_hours;
          
          // Formatear los horarios de manera más legible
          if (typeof businessHours === 'object' && businessHours !== null) {
            Object.entries(businessHours).forEach(([day, hours]) => {
              // Manejar diferentes tipos de valores para hours
              let formattedHours = '';
              if (typeof hours === 'string') {
                formattedHours = hours;
              } else if (Array.isArray(hours)) {
                formattedHours = hours.join(', ');
              } else if (typeof hours === 'object' && hours !== null) {
                formattedHours = JSON.stringify(hours);
              } else {
                formattedHours = String(hours);
              }
              siteSection += `${day}: ${formattedHours}\n`;
            });
          } else {
            siteSection += `${JSON.stringify(businessHours)}\n`;
          }
        } catch (error) {
          console.error(`❌ [BackgroundBuilder] Error procesando business_hours desde site:`, error);
          siteSection += `${JSON.stringify(siteInfo.site.business_hours)}\n`;
        }
      }
    }
    
    // Copywriting (contenido de copywriting desde tabla separada)
    // Reduced verbosity - copywriting check
    
    if (siteInfo.copywriting && siteInfo.copywriting.length > 0) {
      // Reduced verbosity
      try {
        // Los datos ya vienen procesados desde la base de datos
        const copywritingData = siteInfo.copywriting;
        
        // Verificar si hay contenido válido y filtrar solo contenido aprobado
        const approvedCopywriting = Array.isArray(copywritingData) 
          ? copywritingData.filter((item: any) => item && item.status === 'approved') 
          : [];
          
        // Reduced verbosity
          
        if (approvedCopywriting.length > 0) {
          siteSection += `\n## Copywriting Content\n`;
          siteSection += `This section contains approved copywriting content for reference and consistency.\n\n`;
          
          // Organizar por tipo de contenido
          const organizedContent: Record<string, any[]> = {};
          approvedCopywriting.forEach((item: any) => {
            if (item && item.copy_type && item.title && item.content) {
              if (!organizedContent[item.copy_type]) {
                organizedContent[item.copy_type] = [];
              }
              organizedContent[item.copy_type].push({
                title: item.title,
                content: item.content,
                target_audience: item.target_audience || null,
                use_case: item.use_case || null,
                notes: item.notes || null,
                status: item.status || 'draft',
                tags: item.tags || []
              });
            }
          });
          
          // Mostrar contenido organizado por tipo
          Object.entries(organizedContent).forEach(([copyType, items]) => {
            const formattedType = copyType.replace('_', ' ').replace(/\b\w/g, l => l.toUpperCase());
            siteSection += `### ${formattedType}\n`;
            
            items.forEach((item: any, index: number) => {
              siteSection += `${index + 1}. **${item.title}**\n`;
              siteSection += `   Content: ${item.content}\n`;
              
              if (item.target_audience) {
                siteSection += `   Target Audience: ${item.target_audience}\n`;
              }
              
              if (item.use_case) {
                siteSection += `   Use Case: ${item.use_case}\n`;
              }
              
              if (item.notes) {
                siteSection += `   Notes: ${item.notes}\n`;
              }
              
              if (item.tags && item.tags.length > 0) {
                siteSection += `   Tags: ${item.tags.join(', ')}\n`;
              }
              
              siteSection += `\n`; // Solo agregar espacio, no mostrar status ya que todos son 'approved'
            });
          });
        } else {
          // Si copywriting no es un array válido, mostrar como JSON
          siteSection += `\n## Copywriting Content\n${JSON.stringify(copywritingData)}\n`;
        }
      } catch (error) {
        console.error(`❌ [BackgroundBuilder] Error procesando copywriting:`, error);
        siteSection += `\n## Copywriting Content\n${JSON.stringify(siteInfo.copywriting)}\n`;
      }
    }
    
    // Añadir configuración del sitio si está disponible
    if (siteInfo.settings) {
      // Reduced verbosity
      
      siteSection += `\n## Site Configuration\n`;
      
      // Información general
      siteSection += `About: ${siteInfo.settings.about || 'Not specified'}\n`;
      siteSection += `Company Size: ${siteInfo.settings.company_size || 'Not specified'}\n`;
      siteSection += `Industry: ${siteInfo.settings.industry || 'Not specified'}\n`;
      
      // Business Model si está disponible
      if (siteInfo.settings.business_model) {
        // Reduced verbosity
        try {
          const businessModelData = typeof siteInfo.settings.business_model === 'string'
            ? JSON.parse(siteInfo.settings.business_model)
            : siteInfo.settings.business_model;
          
          siteSection += `\n## Business Model\n`;
          
          // Formatear el business model de manera legible
          const activeModels = [];
          if (businessModelData.b2b === true) activeModels.push('B2B (Business to Business)');
          if (businessModelData.b2c === true) activeModels.push('B2C (Business to Consumer)');
          if (businessModelData.b2b2c === true) activeModels.push('B2B2C (Business to Business to Consumer)');
          
          if (activeModels.length > 0) {
            siteSection += `Active Business Models: ${activeModels.join(', ')}\n`;
          } else {
            siteSection += `Business Model Configuration: ${JSON.stringify(businessModelData)}\n`;
          }
        } catch (error) {
          console.error(`❌ [BackgroundBuilder] Error procesando business_model:`, error);
          siteSection += `\nBusiness Model: ${JSON.stringify(siteInfo.settings.business_model)}\n`;
        }
      }
      
      // Interpretar el focus_mode si está disponible (ahora en settings)
      if (siteInfo.settings.focus_mode !== undefined && siteInfo.settings.focus_mode !== null) {
        let focusInterpretation = '';
        const focusValue = parseInt(siteInfo.settings.focus_mode);
        
        if (focusValue === 0) {
          focusInterpretation = 'Completely focused on sales and revenue';
        } else if (focusValue < 25) {
          focusInterpretation = 'High priority on sales and revenue';
        } else if (focusValue < 45) {
          focusInterpretation = 'Moderately focused on sales with some growth considerations';
        } else if (focusValue >= 45 && focusValue <= 55) {
          focusInterpretation = 'Balanced focus between revenue and growth';
        } else if (focusValue < 75) {
          focusInterpretation = 'Moderately focused on growth with some revenue considerations';
        } else if (focusValue < 100) {
          focusInterpretation = 'High priority on growth and usage';
        } else {
          focusInterpretation = 'Completely focused on growth and usage';
        }
        
        siteSection += `Focus Mode: ${focusValue} (${focusInterpretation})\n`;
      }
      
      // Análisis SWOT
      if (siteInfo.settings.swot) {
        try {
          // Reduced verbosity
          if (typeof siteInfo.settings.swot === 'string') {
            // Reduced verbosity
          } else {
            // Reduced verbosity
          }
          
          // Añadimos estructura mejorada para SWOT
          siteSection += `\n## SWOT Analysis\n`;
          
          // Verficamos si es un objeto o un string que hay que parsear
          const swotData = typeof siteInfo.settings.swot === 'string' 
            ? JSON.parse(siteInfo.settings.swot) 
            : siteInfo.settings.swot;
            
          // Estructurar cada componente del SWOT
          siteSection += `### Strengths\n${swotData.strengths || 'Not specified'}\n\n`;
          siteSection += `### Weaknesses\n${swotData.weaknesses || 'Not specified'}\n\n`;
          siteSection += `### Opportunities\n${swotData.opportunities || 'Not specified'}\n\n`;
          siteSection += `### Threats\n${swotData.threats || 'Not specified'}\n`;
        } catch (error) {
          console.error(`❌ [BackgroundBuilder] Error procesando SWOT:`, error);
          siteSection += `\nSWOT Analysis: ${JSON.stringify(siteInfo.settings.swot)}\n`;
        }
      }
      
      // Información de marketing
      if (siteInfo.settings.marketing_budget) {
        // Reduced verbosity
        try {
          // Mejorar estructura del presupuesto de marketing
          const budgetData = typeof siteInfo.settings.marketing_budget === 'string'
            ? JSON.parse(siteInfo.settings.marketing_budget)
            : siteInfo.settings.marketing_budget;
            
          siteSection += `\n## Marketing Budget\n`;
          siteSection += `Total Budget: $${budgetData.total || 0} USD\n`;
          siteSection += `Available Budget: $${budgetData.available || 0} USD\n`;
          
          // Si hay más datos de presupuesto, mostrarlos
          const otherKeys = Object.keys(budgetData).filter(k => !['total', 'available'].includes(k));
          if (otherKeys.length > 0) {
            siteSection += `Additional Budget Information: ${JSON.stringify(
              otherKeys.reduce((obj, key) => ({ ...obj, [key]: budgetData[key] }), {})
            )}\n`;
          }
        } catch (error) {
          console.error(`❌ [BackgroundBuilder] Error procesando marketing_budget:`, error);
          siteSection += `\nMarketing Budget: ${JSON.stringify(siteInfo.settings.marketing_budget)}\n`;
        }
      }
      
      // Productos (en una sección separada)
      if (siteInfo.settings.products) {
        // Reduced verbosity
        siteSection += `\n## Products\n${JSON.stringify(siteInfo.settings.products)}\n`;
      }
      
      // Servicios (en una sección separada)
      if (siteInfo.settings.services) {
        // Reduced verbosity
        siteSection += `\n## Services\n${JSON.stringify(siteInfo.settings.services)}\n`;
      }
      
      // Branding (información de identidad de marca)
      if (siteInfo.settings.branding) {
        // Reduced verbosity
        siteSection += `\n## Brand Identity\n`;
        try {
          const brandingData = typeof siteInfo.settings.branding === 'string'
            ? JSON.parse(siteInfo.settings.branding)
            : siteInfo.settings.branding;
          
          // Brand Pyramid
          if (brandingData.brand_pyramid) {
            siteSection += `### Brand Pyramid\n`;
            if (brandingData.brand_pyramid.brand_essence) {
              siteSection += `Brand Essence: ${brandingData.brand_pyramid.brand_essence}\n`;
            }
            if (brandingData.brand_pyramid.brand_personality) {
              siteSection += `Brand Personality: ${brandingData.brand_pyramid.brand_personality}\n`;
            }
            if (brandingData.brand_pyramid.brand_benefits) {
              siteSection += `Brand Benefits: ${brandingData.brand_pyramid.brand_benefits}\n`;
            }
            if (brandingData.brand_pyramid.brand_attributes) {
              siteSection += `Brand Attributes: ${brandingData.brand_pyramid.brand_attributes}\n`;
            }
            if (brandingData.brand_pyramid.brand_values) {
              siteSection += `Brand Values: ${brandingData.brand_pyramid.brand_values}\n`;
            }
            if (brandingData.brand_pyramid.brand_promise) {
              siteSection += `Brand Promise: ${brandingData.brand_pyramid.brand_promise}\n`;
            }
            siteSection += `\n`;
          }
          
          // Brand Archetype
          if (brandingData.brand_archetype) {
            siteSection += `### Brand Archetype\n${brandingData.brand_archetype}\n\n`;
          }
          
          // Voice and Tone
          if (brandingData.voice_and_tone) {
            siteSection += `### Voice and Tone\n`;
            if (brandingData.voice_and_tone.communication_style) {
              siteSection += `Communication Style: ${brandingData.voice_and_tone.communication_style}\n`;
            }
            if (brandingData.voice_and_tone.personality_traits && Array.isArray(brandingData.voice_and_tone.personality_traits)) {
              siteSection += `Personality Traits: ${brandingData.voice_and_tone.personality_traits.join(', ')}\n`;
            }
            if (brandingData.voice_and_tone.forbidden_words && Array.isArray(brandingData.voice_and_tone.forbidden_words)) {
              siteSection += `Forbidden Words: ${brandingData.voice_and_tone.forbidden_words.join(', ')}\n`;
            }
            if (brandingData.voice_and_tone.preferred_phrases && Array.isArray(brandingData.voice_and_tone.preferred_phrases)) {
              siteSection += `Preferred Phrases: ${brandingData.voice_and_tone.preferred_phrases.join(', ')}\n`;
            }
            siteSection += `\n`;
          }
          
          // Brand Guidelines
          if (brandingData.brand_guidelines) {
            siteSection += `### Brand Guidelines\n`;
            if (brandingData.brand_guidelines.do_list && Array.isArray(brandingData.brand_guidelines.do_list)) {
              siteSection += `Do: ${brandingData.brand_guidelines.do_list.join(', ')}\n`;
            }
            if (brandingData.brand_guidelines.dont_list && Array.isArray(brandingData.brand_guidelines.dont_list)) {
              siteSection += `Don't: ${brandingData.brand_guidelines.dont_list.join(', ')}\n`;
            }
            if (brandingData.brand_guidelines.emotions_to_evoke && Array.isArray(brandingData.brand_guidelines.emotions_to_evoke)) {
              siteSection += `Emotions to Evoke: ${brandingData.brand_guidelines.emotions_to_evoke.join(', ')}\n`;
            }
            siteSection += `\n`;
          }
          
          // Color Palette
          if (brandingData.color_palette) {
            siteSection += `### Color Palette\n`;
            if (brandingData.color_palette.primary_color) {
              siteSection += `Primary Color: ${brandingData.color_palette.primary_color}\n`;
            }
            if (brandingData.color_palette.secondary_color) {
              siteSection += `Secondary Color: ${brandingData.color_palette.secondary_color}\n`;
            }
            if (brandingData.color_palette.accent_color) {
              siteSection += `Accent Color: ${brandingData.color_palette.accent_color}\n`;
            }
            siteSection += `\n`;
          }
          
          // Typography
          if (brandingData.typography) {
            siteSection += `### Typography\n`;
            if (brandingData.typography.primary_font) {
              siteSection += `Primary Font: ${brandingData.typography.primary_font}\n`;
            }
            if (brandingData.typography.secondary_font) {
              siteSection += `Secondary Font: ${brandingData.typography.secondary_font}\n`;
            }
            if (brandingData.typography.font_size_scale) {
              siteSection += `Font Size Scale: ${brandingData.typography.font_size_scale}\n`;
            }
            siteSection += `\n`;
          }
          
        } catch (error) {
          console.error(`❌ [BackgroundBuilder] Error procesando branding:`, error);
          siteSection += `Brand Identity: ${JSON.stringify(siteInfo.settings.branding)}\n`;
        }
      }
      
      // Ubicaciones con procesamiento de restrictions
      if (siteInfo.settings.locations) {
        // Reduced verbosity
        
        try {
          // Parsear locations si es string
          const locationsData = typeof siteInfo.settings.locations === 'string'
            ? JSON.parse(siteInfo.settings.locations)
            : siteInfo.settings.locations;
          
          // Validar y procesar cada location
          const processedLocations = Array.isArray(locationsData) 
            ? locationsData.map((location, index) => {
                try {
                  // Validar la estructura de la location usando el schema
                  const validatedLocation = LocationSchema.parse(location);
                  
                  // Procesar restrictions si existe (reduced verbosity)
                  if (validatedLocation.restrictions) {
                    // Location has restrictions - processing silently
                  }
                  
                  return validatedLocation;
                } catch (validationError) {
                  console.warn(`⚠️ [BackgroundBuilder] Error validando location ${index + 1}:`, validationError);
                  // Si la validación falla, retornamos la location original pero sin restrictions
                  const { restrictions, ...locationWithoutRestrictions } = location;
                  return locationWithoutRestrictions;
                }
              })
            : locationsData;
          
          // Aplicar formateo mejorado (limpia valores vacíos y cambia nomenclatura)
          const formattedLocations = formatLocations(Array.isArray(processedLocations) ? processedLocations : [processedLocations]);
          
          // Parsear y formatear como texto legible
          siteSection += `\n## Locations\n`;
          formattedLocations.forEach((location, index) => {
            // Información básica de la ubicación
            const locationParts = [];
            if (location.name) locationParts.push(location.name);
            if (location.city) locationParts.push(location.city);
            if (location.state) locationParts.push(location.state);
            if (location.country) locationParts.push(location.country);
            if (location.zip) locationParts.push(`(${location.zip})`);
            if (location.address) locationParts.push(`- ${location.address}`);
            
            siteSection += `${index + 1}. ${locationParts.join(', ')}\n`;
            
            // Restricciones de servicio si existen
            if (location.restrictions && location.restrictions.enabled) {
              if (location.restrictions.service_only_available_in && location.restrictions.service_only_available_in.length > 0) {
                siteSection += `   Service only available in: `;
                const availableIn = location.restrictions.service_only_available_in.map((addr: any) => {
                  const parts = [];
                  if (addr.name) parts.push(addr.name);
                  if (addr.city) parts.push(addr.city);
                  if (addr.state) parts.push(addr.state);
                  if (addr.country) parts.push(addr.country);
                  return parts.join(', ');
                }).filter((part: string) => part.length > 0);
                siteSection += `${availableIn.join('; ')}\n`;
              }
              
              if (location.restrictions.service_excluded_in && location.restrictions.service_excluded_in.length > 0) {
                siteSection += `   Service excluded in: `;
                const excludedIn = location.restrictions.service_excluded_in.map((addr: any) => {
                  const parts = [];
                  if (addr.name) parts.push(addr.name);
                  if (addr.city) parts.push(addr.city);
                  if (addr.state) parts.push(addr.state);
                  if (addr.country) parts.push(addr.country);
                  return parts.join(', ');
                }).filter((part: string) => part.length > 0);
                siteSection += `${excludedIn.join('; ')}\n`;
              }
            }
            
            siteSection += `\n`; // Espacio entre ubicaciones
          });
          
        } catch (error) {
          console.error(`❌ [BackgroundBuilder] Error procesando locations:`, error);
          siteSection += `\n## Locations\n${JSON.stringify(siteInfo.settings.locations)}\n`;
        }
      }
      
      if (siteInfo.settings.marketing_channels) {
        // Reduced verbosity
        siteSection += `\n## Marketing Channels\n${JSON.stringify(siteInfo.settings.marketing_channels)}\n`;
      }
      
      // Channels - información pública de canales de comunicación
      if (siteInfo.settings.channels) {
        // Reduced verbosity
        try {
          const channelsData = typeof siteInfo.settings.channels === 'string'
            ? JSON.parse(siteInfo.settings.channels)
            : siteInfo.settings.channels;
          
          if (channelsData && typeof channelsData === 'object') {
            siteSection += `\n## Communication Channels\n`;
            
            // Email channel
            if (channelsData.email && typeof channelsData.email === 'object') {
              const emailChannel = channelsData.email;
              siteSection += `### Email\n`;
              
              if (emailChannel.email) {
                siteSection += `Primary Email: ${emailChannel.email}\n`;
              }
              
              if (emailChannel.aliases) {
                siteSection += `Email Aliases: ${emailChannel.aliases}\n`;
              }
              
              if (emailChannel.status) {
                siteSection += `Status: ${emailChannel.status}\n`;
              }
              
              if (emailChannel.enabled !== undefined) {
                siteSection += `Enabled: ${emailChannel.enabled ? 'Yes' : 'No'}\n`;
              }
              
              siteSection += `\n`;
            }
            
            // WhatsApp channel
            if (channelsData.whatsapp && typeof channelsData.whatsapp === 'object') {
              const whatsappChannel = channelsData.whatsapp;
              siteSection += `### WhatsApp\n`;
              
              if (whatsappChannel.status) {
                siteSection += `Status: ${whatsappChannel.status}\n`;
              }
              
              if (whatsappChannel.enabled !== undefined) {
                siteSection += `Enabled: ${whatsappChannel.enabled ? 'Yes' : 'No'}\n`;
              }
              
              if (whatsappChannel.existingNumber) {
                siteSection += `Phone Number: ${whatsappChannel.existingNumber}\n`;
              }
              
              siteSection += `\n`;
            }
            
            // Web channel
            if (channelsData.web && typeof channelsData.web === 'object') {
              const webChannel = channelsData.web;
              siteSection += `### Web\n`;
              
              if (webChannel.status) {
                siteSection += `Status: ${webChannel.status}\n`;
              }
              
              if (webChannel.enabled !== undefined) {
                siteSection += `Enabled: ${webChannel.enabled ? 'Yes' : 'No'}\n`;
              }
              
              if (webChannel.url) {
                siteSection += `URL: ${webChannel.url}\n`;
              }
              
              siteSection += `\n`;
            }
            
            // Otros canales si existen
            const handledChannels = ['email', 'whatsapp', 'web'];
            Object.keys(channelsData).forEach(channelName => {
              if (!handledChannels.includes(channelName)) {
                const channelData = channelsData[channelName];
                if (channelData && typeof channelData === 'object') {
                  const formattedName = channelName.charAt(0).toUpperCase() + channelName.slice(1);
                  siteSection += `### ${formattedName}\n`;
                  
                  // Solo mostrar información pública básica
                  const publicFields = ['status', 'enabled'];
                  
                  Object.entries(channelData).forEach(([key, value]) => {
                    if (publicFields.includes(key) && value !== null && value !== undefined && value !== '') {
                      const formattedKey = key.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
                      if (key === 'enabled') {
                        siteSection += `${formattedKey}: ${value ? 'Yes' : 'No'}\n`;
                      } else {
                        siteSection += `${formattedKey}: ${value}\n`;
                      }
                    }
                  });
                  
                  siteSection += `\n`;
                }
              }
            });
          }
        } catch (error) {
          console.error(`❌ [BackgroundBuilder] Error procesando channels:`, error);
          siteSection += `\n## Communication Channels\n${JSON.stringify(siteInfo.settings.channels)}\n`;
        }
      }
      
      if (siteInfo.settings.social_media) {
        // Reduced verbosity
        
        // Parsear social_media si es string (con try/catch preventivo)
        let socialMediaData: any = null;
        try {
          socialMediaData = typeof siteInfo.settings.social_media === 'string'
            ? JSON.parse(siteInfo.settings.social_media)
            : siteInfo.settings.social_media;
        } catch (error) {
          console.error(`❌ [BackgroundBuilder] Error parsing social_media:`, error);
          socialMediaData = null; // Evita romper la generación del background
        }
        
        // Verificar si es un array (estructura nueva) o un objeto (estructura antigua)
        let filteredSocialMedia: Record<string, string> = {};
        
        if (Array.isArray(socialMediaData)) {
          // Procesar array de objetos de social media
          socialMediaData.forEach(item => {
            if (item && item.platform) {
              // Determinar qué información mostrar para cada plataforma
              let displayInfo = '';
              
              // Priorizar URL si está disponible
              if (item.url && item.url.trim() !== '') {
                displayInfo = item.url.trim();
              }
              // Si no hay URL pero hay handle, usar handle
              else if (item.handle && item.handle.trim() !== '') {
                displayInfo = item.handle.trim();
              }
              // Si no hay URL ni handle pero hay phone, usar phone
              else if (item.phone && item.phone.trim() !== '') {
                displayInfo = item.phone.trim();
              }
              
              // Solo añadir si hay información útil
              if (displayInfo) {
                filteredSocialMedia[item.platform] = displayInfo;
              }
            }
          });
        } else if (typeof socialMediaData === 'object' && socialMediaData !== null) {
          // Procesar objeto tradicional (compatibilidad hacia atrás)
          filteredSocialMedia = Object.entries(socialMediaData)
            .filter(([key, value]) => {
              // Filtrar valores vacíos, null, undefined, strings vacíos, arrays vacíos
              if (value === null || value === undefined || value === '') {
                return false;
              }
              if (Array.isArray(value) && value.length === 0) {
                return false;
              }
              if (typeof value === 'string' && value.trim() === '') {
                return false;
              }
              return true;
            })
            .reduce((obj, [key, value]) => ({ ...obj, [key]: value }), {});
        }
        
        // Solo añadir la sección si hay al menos una plataforma con información válida
        if (Object.keys(filteredSocialMedia).length > 0) {
          siteSection += `\n## Social Media\n`;
          Object.entries(filteredSocialMedia).forEach(([platform, info]) => {
            // Capitalizar la primera letra de la plataforma para mejor presentación
            const capitalizedPlatform = platform.charAt(0).toUpperCase() + platform.slice(1);
            siteSection += `${capitalizedPlatform}: ${info}\n`;
          });
        }
      }
      
      // Customer Journey Tactics (CRITICAL INFORMATION)
      if (siteInfo.settings.customer_journey) {
        // Reduced verbosity
        siteSection += this.createCustomerJourneySection(siteInfo.settings.customer_journey);
      }
      
      // Agregar objetivos/metas si están disponibles
      if (siteInfo.settings.goals) {
        // Reduced verbosity
        siteSection += `\n## Goals\n${JSON.stringify(siteInfo.settings.goals)}\n`;
      }
      
      // Información del equipo
      if (siteInfo.settings.team_members) {
        // Reduced verbosity
        siteSection += `\n## Team Members\n${JSON.stringify(siteInfo.settings.team_members)}\n`;
      }
      
      if (siteInfo.settings.team_roles) {
        // Reduced verbosity
        siteSection += `\n## Team Roles\n${JSON.stringify(siteInfo.settings.team_roles)}\n`;
      }
      
      if (siteInfo.settings.org_structure) {
        // Reduced verbosity
        siteSection += `\n## Organizational Structure\n${JSON.stringify(siteInfo.settings.org_structure)}\n`;
      }
      
      // Agregar horarios de atención si están disponibles (desde site_settings)
      // Solo agregar si no se agregaron ya desde site para evitar duplicación
      if (siteInfo.settings.business_hours && 
          Object.keys(siteInfo.settings.business_hours).length > 0 &&
          (!siteInfo.site || !siteInfo.site.business_hours || Object.keys(siteInfo.site.business_hours).length === 0)) {
        // Reduced verbosity
        siteSection += `\n## Business Hours\n`;
        try {
          const businessHours = typeof siteInfo.settings.business_hours === 'string'
            ? JSON.parse(siteInfo.settings.business_hours)
            : siteInfo.settings.business_hours;
          
          // Formatear los horarios de manera más legible
          if (typeof businessHours === 'object' && businessHours !== null) {
            Object.entries(businessHours).forEach(([day, hours]) => {
              // Manejar diferentes tipos de valores para hours
              let formattedHours = '';
              if (typeof hours === 'string') {
                formattedHours = hours;
              } else if (Array.isArray(hours)) {
                formattedHours = hours.join(', ');
              } else if (typeof hours === 'object' && hours !== null) {
                formattedHours = JSON.stringify(hours);
              } else {
                formattedHours = String(hours);
              }
              siteSection += `${day}: ${formattedHours}\n`;
            });
          } else {
            siteSection += `${JSON.stringify(businessHours)}\n`;
          }
        } catch (error) {
          console.error(`❌ [BackgroundBuilder] Error procesando business_hours desde site_settings:`, error);
          siteSection += `${JSON.stringify(siteInfo.settings.business_hours)}\n`;
        }
      }
    } else {
      console.log(`⚠️ [BackgroundBuilder] No hay settings disponibles en siteInfo`);
    }
    
    // Reduced verbosity
    return siteSection;
  }

  /**
   * Crea la sección de campañas activas si están disponibles
   */
  private static createActiveCampaignsSection(activeCampaigns: Array<{
    title: string;
    description?: string;
  }>): string {
    if (!activeCampaigns || activeCampaigns.length === 0) return '';
    
    // Reduced verbosity
    
    let campaignsSection = '# Active Campaigns\n';
    campaignsSection += 'The following campaigns are currently active for this site:\n\n';
    
    activeCampaigns.forEach((campaign, index) => {
      campaignsSection += `## Campaign ${index + 1}: ${campaign.title}\n`;
      if (campaign.description) {
        campaignsSection += `Description: ${campaign.description}\n`;
      }
      campaignsSection += '\n';
    });
    
    // Reduced verbosity
    return campaignsSection;
  }
  
  /**
   * Crea la sección de descripción si está disponible
   */
  private static createDescriptionSection(description?: string): string {
    if (!description || !description.trim()) return '';
    
    return `# Description\n${description}`;
  }
  
  /**
   * Crea la sección de capabilities
   */
  private static createCapabilitiesSection(capabilities: string[]): string {
    const capabilitiesStr = capabilities.length > 0
      ? capabilities.join(', ') 
      : 'providing assistance';
    
    return `# Capabilities\nYour capabilities include: ${capabilitiesStr}.`;
  }
  
  /**
   * Crea la sección de instrucciones básicas
   */
  private static createInstructionsSection(name: string): string {
    return `# Instructions
1. Respond helpfully to user requests.
2. Use your capabilities effectively.
3. Be concise and clear in your responses.
4. Your name is "${name}" - whenever asked about your name, identity or what you are, respond with this name.`;
  }
  
  /**
   * Crea la sección de instrucciones del sistema si está disponible
   */
  private static createSystemSection(systemPrompt?: string): string {
    if (!systemPrompt || !systemPrompt.trim()) return '';
    
    // Reduced verbosity
    return `# System Instructions\n${systemPrompt}`;
  }
  
  /**
   * Crea la sección de instrucciones personalizadas si está disponible
   */
  private static createCustomInstructionsSection(agentPrompt?: string): string {
    if (!agentPrompt || !agentPrompt.trim()) return '';
    
    // Reduced verbosity
    return `# Agent Custom Instructions\n${agentPrompt}`;
  }
  
  /**
   * Verifica que el prompt contenga todas las secciones esperadas
   */
  private static verifyPromptSections(
    finalPrompt: string, 
    systemPrompt?: string, 
    agentPrompt?: string, 
    backstory?: string,
    siteInfo?: { site: any | null; settings: any | null; copywriting?: any[] | null }
  ): void {
    if (systemPrompt && !finalPrompt.includes('# System Instructions')) {
      console.error(`⚠️ [BackgroundBuilder] ADVERTENCIA: Se esperaba incluir systemPrompt pero no se encontró en el prompt final`);
    }
    
    if (agentPrompt && !finalPrompt.includes('# Agent Custom Instructions')) {
      console.error(`⚠️ [BackgroundBuilder] ADVERTENCIA: Se esperaba incluir las instrucciones personalizadas pero no se encontraron en el prompt final`);
    }
    
    if (backstory && !finalPrompt.includes('# Backstory')) {
      console.error(`⚠️ [BackgroundBuilder] ADVERTENCIA: Se esperaba incluir backstory pero no se encontró en el prompt final`);
    }
    
    if (siteInfo && siteInfo.site && !finalPrompt.includes('# Site Information')) {
      console.error(`⚠️ [BackgroundBuilder] ADVERTENCIA: Se esperaba incluir información del sitio pero no se encontró en el prompt final`);
    }
    
    if (siteInfo && siteInfo.settings) {
      // Verificar que se incluyeron propiedades específicas del settings
      if (siteInfo.settings.swot && !finalPrompt.includes('SWOT Analysis')) {
        console.error(`⚠️ [BackgroundBuilder] ADVERTENCIA: Se esperaba incluir Análisis SWOT pero no se encontró en el prompt final`);
      }
      
      if (siteInfo.settings.products && !finalPrompt.includes('## Products')) {
        console.error(`⚠️ [BackgroundBuilder] ADVERTENCIA: Se esperaba incluir Productos pero no se encontró en el prompt final`);
      }
      
      if (siteInfo.settings.services && !finalPrompt.includes('## Services')) {
        console.error(`⚠️ [BackgroundBuilder] ADVERTENCIA: Se esperaba incluir Servicios pero no se encontró en el prompt final`);
      }
      
      // Verificar copywriting aprobado
      if (siteInfo.copywriting && siteInfo.copywriting.length > 0) {
        const approvedCopywriting = siteInfo.copywriting.filter((item: any) => item && item.status === 'approved');
        if (approvedCopywriting.length > 0 && !finalPrompt.includes('## Copywriting Content')) {
          console.error(`⚠️ [BackgroundBuilder] ADVERTENCIA: Se esperaba incluir Copywriting Content aprobado pero no se encontró en el prompt final`);
        }
      }
      
      // Verificar business_hours desde cualquier fuente
      const hasBusinessHoursInSite = siteInfo.site && siteInfo.site.business_hours && Object.keys(siteInfo.site.business_hours).length > 0;
      const hasBusinessHoursInSettings = siteInfo.settings && siteInfo.settings.business_hours && Object.keys(siteInfo.settings.business_hours).length > 0;
      
      if ((hasBusinessHoursInSite || hasBusinessHoursInSettings) && !finalPrompt.includes('## Business Hours')) {
        console.error(`⚠️ [BackgroundBuilder] ADVERTENCIA: Se esperaba incluir Business Hours pero no se encontró en el prompt final`);
      }
      
      // Verificar social media solo si hay datos válidos después del filtrado
      if (siteInfo.settings.social_media) {
        try {
          const socialMediaData = typeof siteInfo.settings.social_media === 'string'
            ? JSON.parse(siteInfo.settings.social_media)
            : siteInfo.settings.social_media;
          
          let hasValidSocialMedia = false;
          
          if (Array.isArray(socialMediaData)) {
            // Verificar si hay al menos una plataforma con información válida
            hasValidSocialMedia = socialMediaData.some(item => {
              if (!item || !item.platform) return false;
              
              return (item.url && item.url.trim() !== '') ||
                     (item.handle && item.handle.trim() !== '') ||
                     (item.phone && item.phone.trim() !== '');
            });
          } else if (typeof socialMediaData === 'object' && socialMediaData !== null) {
            // Verificar si hay al menos una entrada válida en el objeto
            hasValidSocialMedia = Object.values(socialMediaData).some(value => {
              if (value === null || value === undefined || value === '') return false;
              if (Array.isArray(value) && value.length === 0) return false;
              if (typeof value === 'string' && value.trim() === '') return false;
              return true;
            });
          }
          
          if (hasValidSocialMedia && !finalPrompt.includes('## Social Media')) {
            console.error(`⚠️ [BackgroundBuilder] ADVERTENCIA: Se esperaba incluir Social Media pero no se encontró en el prompt final`);
          }
        } catch (error) {
          console.error(`⚠️ [BackgroundBuilder] Error al verificar social media en verifyPromptSections:`, error);
        }
      }
      
      if (siteInfo.settings.branding && !finalPrompt.includes('## Brand Identity')) {
        console.error(`⚠️ [BackgroundBuilder] ADVERTENCIA: Se esperaba incluir Brand Identity pero no se encontró en el prompt final`);
      }
      
      if (siteInfo.settings.business_model && !finalPrompt.includes('## Business Model')) {
        console.error(`⚠️ [BackgroundBuilder] ADVERTENCIA: Se esperaba incluir Business Model pero no se encontró en el prompt final`);
      }
      
      // Verificar channels si están disponibles
      if (siteInfo.settings.channels && !finalPrompt.includes('## Communication Channels')) {
        console.error(`⚠️ [BackgroundBuilder] ADVERTENCIA: Se esperaba incluir Communication Channels pero no se encontró en el prompt final`);
      }
      
      // Verificar customer journey tactics si están disponibles
      if (siteInfo.settings.customer_journey) {
        try {
          const journeyData = typeof siteInfo.settings.customer_journey === 'string' 
            ? JSON.parse(siteInfo.settings.customer_journey) 
            : siteInfo.settings.customer_journey;
          
          const stages = ['awareness', 'consideration', 'decision', 'purchase', 'retention', 'referral'];
          const hasValidContent = stages.some(stage => {
            const stageData = journeyData[stage];
            if (!stageData || typeof stageData !== 'object') return false;
            
            return ['metrics', 'actions', 'tactics'].some(category => {
              const categoryData = stageData[category];
              return Array.isArray(categoryData) && categoryData.length > 0 && 
                     categoryData.some((item: any) => item && typeof item === 'string' && item.trim() !== '');
            });
          });
          
          if (hasValidContent && !finalPrompt.includes('## ⚠️ IMPORTANT: Customer Journey Strategy')) {
            console.error(`⚠️ [BackgroundBuilder] ADVERTENCIA: Se esperaba incluir Customer Journey Strategy pero no se encontró en el prompt final`);
          }
        } catch (error) {
          console.error(`⚠️ [BackgroundBuilder] Error al verificar customer_journey en verifyPromptSections:`, error);
        }
      }
    }
  }
  
  /**
   * Crea la sección de Customer Journey Tactics
   */
  private static createCustomerJourneySection(customerJourney: any): string {
    try {
      const journeyData = typeof customerJourney === 'string' 
        ? JSON.parse(customerJourney) 
        : customerJourney;
      
      if (!journeyData || typeof journeyData !== 'object') {
        return '';
      }
      
      // Verificar si hay al menos una etapa con contenido válido
      const stages = ['awareness', 'consideration', 'decision', 'purchase', 'retention', 'referral'];
      const hasValidContent = stages.some(stage => {
        const stageData = journeyData[stage];
        if (!stageData || typeof stageData !== 'object') return false;
        
        return ['metrics', 'actions', 'tactics'].some(category => {
          const categoryData = stageData[category];
          return Array.isArray(categoryData) && categoryData.length > 0 && 
                 categoryData.some(item => item && typeof item === 'string' && item.trim() !== '');
        });
      });
      
      if (!hasValidContent) {
        return '';
      }
      
      let journeySection = '\n## ⚠️ IMPORTANT: Customer Journey Strategy\n';
      journeySection += '**CRITICAL**: All activities, tasks, and communications must consider the appropriate customer journey stage.\n';
      journeySection += 'Always align your actions with the lead\'s current stage and the objective of each task.\n';
      journeySection += 'This strategic framework guides all agent operations and decision-making.\n\n';
      
      stages.forEach(stage => {
        const stageData = journeyData[stage];
        if (!stageData || typeof stageData !== 'object') return;
        
        // Verificar si la etapa tiene contenido válido
        const hasStageContent = ['metrics', 'actions', 'tactics'].some(category => {
          const categoryData = stageData[category];
          return Array.isArray(categoryData) && categoryData.length > 0 && 
                 categoryData.some(item => item && typeof item === 'string' && item.trim() !== '');
        });
        
        if (!hasStageContent) return;
        
        // Capitalizar la primera letra y formatear el nombre de la etapa
        const stageName = stage.charAt(0).toUpperCase() + stage.slice(1);
        journeySection += `### ${stageName} Stage\n`;
        
        // Añadir métricas si están disponibles
        if (Array.isArray(stageData.metrics) && stageData.metrics.length > 0) {
          const validMetrics = stageData.metrics.filter((metric: any) => 
            metric && typeof metric === 'string' && metric.trim() !== ''
          );
          if (validMetrics.length > 0) {
            journeySection += `**Key Metrics:** ${validMetrics.join(', ')}\n`;
          }
        }
        
        // Añadir acciones si están disponibles
        if (Array.isArray(stageData.actions) && stageData.actions.length > 0) {
          const validActions = stageData.actions.filter((action: any) => 
            action && typeof action === 'string' && action.trim() !== ''
          );
          if (validActions.length > 0) {
            journeySection += `**Strategic Actions:** ${validActions.join(', ')}\n`;
          }
        }
        
        // Añadir tácticas si están disponibles
        if (Array.isArray(stageData.tactics) && stageData.tactics.length > 0) {
          const validTactics = stageData.tactics.filter((tactic: any) => 
            tactic && typeof tactic === 'string' && tactic.trim() !== ''
          );
          if (validTactics.length > 0) {
            journeySection += `**Implementation Tactics:** ${validTactics.join(', ')}\n`;
          }
        }
        
        journeySection += '\n';
      });
      
      // Reduced verbosity
      return journeySection;
      
    } catch (error) {
      console.error(`❌ [BackgroundBuilder] Error procesando customer_journey:`, error);
      return '';
    }
  }

  /**
   * Crea un background de emergencia en caso de error
   */
  public static createEmergencyBackground(id: string, name: string, capabilities: string[]): string {
    console.log(`⚠️ [BackgroundBuilder] Generando background mínimo de emergencia para: ${id}`);
    
    const fallbackCapabilities = capabilities.length > 0 
      ? capabilities 
      : ['providing assistance'];
    
    const emergencyBackground = `# Agent Identity
You are ${name} (ID: ${id}).

# Capabilities
Your capabilities include: ${Array.isArray(fallbackCapabilities) ? fallbackCapabilities.join(', ') : 'providing assistance'}.

# Instructions
1. Respond helpfully to user requests.
2. Use your capabilities effectively.
3. Be concise and clear in your responses.
4. Your name is "${name}" - whenever asked about your name, identity or what you are, respond with this name.`;
    
    console.log(`⚠️ [BackgroundBuilder] Background de emergencia generado (${emergencyBackground.length} caracteres)`);
    return emergencyBackground;
  }
} 