/**
 * BackgroundBuilder.ts
 * Clase para construir el texto de background del agente de manera estructurada
 */

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
    },
    activeCampaigns?: Array<{
      title: string;
      description?: string;
    }>
  ): string {
    console.log(`🧩 [BackgroundBuilder] Construyendo prompt para ${name} (${id})`);
    console.log(`🧩 [BackgroundBuilder] AgentPrompt disponible: ${agentPrompt ? 'SÍ' : 'NO'} - Longitud: ${agentPrompt ? agentPrompt.length : 0}`);
    console.log(`🧩 [BackgroundBuilder] SystemPrompt disponible: ${systemPrompt ? 'SÍ' : 'NO'} - Longitud: ${systemPrompt ? systemPrompt.length : 0}`);
    console.log(`🧩 [BackgroundBuilder] Backstory disponible: ${backstory ? 'SÍ' : 'NO'} - Longitud: ${backstory ? backstory.length : 0}`);
    console.log(`🧩 [BackgroundBuilder] SiteInfo disponible: ${siteInfo ? 'SÍ' : 'NO'}`);
    if (siteInfo) {
      console.log(`🧩 [BackgroundBuilder] SiteInfo.site disponible: ${siteInfo.site ? 'SÍ' : 'NO'}`);
      console.log(`🧩 [BackgroundBuilder] SiteInfo.settings disponible: ${siteInfo.settings ? 'SÍ' : 'NO'}`);
      if (siteInfo.site) {
        console.log(`🧩 [BackgroundBuilder] SiteInfo.site tiene los campos: ${Object.keys(siteInfo.site).join(', ')}`);
      }
      if (siteInfo.settings) {
        console.log(`🧩 [BackgroundBuilder] SiteInfo.settings tiene los campos: ${Object.keys(siteInfo.settings).join(', ')}`);
      }
    }
    console.log(`🧩 [BackgroundBuilder] Capabilities recibidas (${capabilities.length}): ${capabilities.join(', ')}`);
    
    // Log específico para branding
    if (siteInfo && siteInfo.settings && siteInfo.settings.branding) {
      console.log(`🧩 [BackgroundBuilder] Branding disponible: SÍ`);
    } else {
      console.log(`🧩 [BackgroundBuilder] Branding disponible: NO`);
    }
    
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
      // No incluimos siteInfo si es null o los dos campos son null
      (!siteInfo || (!siteInfo.site && !siteInfo.settings)) ? '' : this.createSiteInfoSection(siteInfo),
      // Incluir campañas activas si están disponibles
      (!activeCampaigns || activeCampaigns.length === 0) ? '' : this.createActiveCampaignsSection(activeCampaigns)
    ];
    
    // Unir todas las secciones, filtrando las vacías
    const finalPrompt = sections
      .filter(section => section.trim() !== '')
      .join('\n\n');
    
    console.log(`📏 [BackgroundBuilder] Longitud total del prompt generado: ${finalPrompt.length} caracteres`);
    
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
    
    console.log(`🔍 [BackgroundBuilder] Añadiendo backstory del agente: ${backstory.substring(0, 50)}...`);
    return `# Backstory\n${backstory}`;
  }
  
  /**
   * Crea la sección de información del sitio si está disponible
   */
  private static createSiteInfoSection(siteInfo?: { site: any | null; settings: any | null }): string {
    if (!siteInfo || (!siteInfo.site && !siteInfo.settings)) return '';
    
    console.log(`🔍 [BackgroundBuilder] Iniciando creación de sección de sitio`);
    let siteSection = '# Site Information\n';
    
    // Añadir información básica del sitio
    if (siteInfo.site) {
      console.log(`🔍 [BackgroundBuilder] Añadiendo información del sitio: ${siteInfo.site.name || 'Sitio Desconocido'}`);
      
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
        console.log(`🔍 [BackgroundBuilder] Añadiendo business_hours desde site`);
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
    
    // Añadir configuración del sitio si está disponible
    if (siteInfo.settings) {
      console.log(`🔍 [BackgroundBuilder] Añadiendo configuración del sitio (type: ${typeof siteInfo.settings})`);
      console.log(`🔍 [BackgroundBuilder] Settings keys: ${Object.keys(siteInfo.settings).join(', ')}`);
      
      siteSection += `\n## Site Configuration\n`;
      
      // Información general
      siteSection += `About: ${siteInfo.settings.about || 'Not specified'}\n`;
      siteSection += `Company Size: ${siteInfo.settings.company_size || 'Not specified'}\n`;
      siteSection += `Industry: ${siteInfo.settings.industry || 'Not specified'}\n`;
      
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
          console.log(`🔍 [BackgroundBuilder] Añadiendo SWOT (type: ${typeof siteInfo.settings.swot})`);
          if (typeof siteInfo.settings.swot === 'string') {
            console.log(`🔍 [BackgroundBuilder] SWOT es un string, intentando parsear: ${siteInfo.settings.swot.substring(0, 50)}...`);
          } else {
            console.log(`🔍 [BackgroundBuilder] SWOT keys: ${Object.keys(siteInfo.settings.swot).join(', ')}`);
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
        console.log(`🔍 [BackgroundBuilder] Añadiendo marketing_budget`);
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
        console.log(`🔍 [BackgroundBuilder] Añadiendo products`);
        siteSection += `\n## Products\n${JSON.stringify(siteInfo.settings.products)}\n`;
      }
      
      // Servicios (en una sección separada)
      if (siteInfo.settings.services) {
        console.log(`🔍 [BackgroundBuilder] Añadiendo services`);
        siteSection += `\n## Services\n${JSON.stringify(siteInfo.settings.services)}\n`;
      }
      
      // Branding (información de identidad de marca)
      if (siteInfo.settings.branding) {
        console.log(`🔍 [BackgroundBuilder] Añadiendo branding`);
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
      
      // Ubicaciones
      if (siteInfo.settings.locations) {
        console.log(`🔍 [BackgroundBuilder] Añadiendo locations`);
        siteSection += `\n## Locations\n${JSON.stringify(siteInfo.settings.locations)}\n`;
      }
      
      if (siteInfo.settings.marketing_channels) {
        console.log(`🔍 [BackgroundBuilder] Añadiendo marketing_channels`);
        siteSection += `\n## Marketing Channels\n${JSON.stringify(siteInfo.settings.marketing_channels)}\n`;
      }
      
      if (siteInfo.settings.social_media) {
        console.log(`🔍 [BackgroundBuilder] Añadiendo social_media`);
        
        // Parsear social_media si es string
        const socialMediaData = typeof siteInfo.settings.social_media === 'string'
          ? JSON.parse(siteInfo.settings.social_media)
          : siteInfo.settings.social_media;
        
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
      
      // Agregar objetivos/metas si están disponibles
      if (siteInfo.settings.goals) {
        console.log(`🔍 [BackgroundBuilder] Añadiendo goals`);
        siteSection += `\n## Goals\n${JSON.stringify(siteInfo.settings.goals)}\n`;
      }
      
      // Información del equipo
      if (siteInfo.settings.team_members) {
        console.log(`🔍 [BackgroundBuilder] Añadiendo team_members`);
        siteSection += `\n## Team Members\n${JSON.stringify(siteInfo.settings.team_members)}\n`;
      }
      
      if (siteInfo.settings.team_roles) {
        console.log(`🔍 [BackgroundBuilder] Añadiendo team_roles`);
        siteSection += `\n## Team Roles\n${JSON.stringify(siteInfo.settings.team_roles)}\n`;
      }
      
      if (siteInfo.settings.org_structure) {
        console.log(`🔍 [BackgroundBuilder] Añadiendo org_structure`);
        siteSection += `\n## Organizational Structure\n${JSON.stringify(siteInfo.settings.org_structure)}\n`;
      }
      
      // Agregar horarios de atención si están disponibles (desde site_settings)
      // Solo agregar si no se agregaron ya desde site para evitar duplicación
      if (siteInfo.settings.business_hours && 
          Object.keys(siteInfo.settings.business_hours).length > 0 &&
          (!siteInfo.site || !siteInfo.site.business_hours || Object.keys(siteInfo.site.business_hours).length === 0)) {
        console.log(`🔍 [BackgroundBuilder] Añadiendo business_hours desde site_settings`);
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
    
    console.log(`🔍 [BackgroundBuilder] Sección de sitio creada (${siteSection.length} caracteres)`);
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
    
    console.log(`🔍 [BackgroundBuilder] Añadiendo ${activeCampaigns.length} campañas activas al background`);
    
    let campaignsSection = '# Active Campaigns\n';
    campaignsSection += 'The following campaigns are currently active for this site:\n\n';
    
    activeCampaigns.forEach((campaign, index) => {
      campaignsSection += `## Campaign ${index + 1}: ${campaign.title}\n`;
      if (campaign.description) {
        campaignsSection += `Description: ${campaign.description}\n`;
      }
      campaignsSection += '\n';
    });
    
    console.log(`🔍 [BackgroundBuilder] Sección de campañas activas creada (${campaignsSection.length} caracteres)`);
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
    
    console.log(`🔍 [BackgroundBuilder] Añadiendo systemPrompt: ${systemPrompt.substring(0, 50)}...`);
    return `# System Instructions\n${systemPrompt}`;
  }
  
  /**
   * Crea la sección de instrucciones personalizadas si está disponible
   */
  private static createCustomInstructionsSection(agentPrompt?: string): string {
    if (!agentPrompt || !agentPrompt.trim()) return '';
    
    console.log(`🔍 [BackgroundBuilder] Añadiendo prompt específico del agente: ${agentPrompt.substring(0, 50)}...`);
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
    siteInfo?: { site: any | null; settings: any | null }
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
      
      // Verificar business_hours desde cualquier fuente
      const hasBusinessHoursInSite = siteInfo.site && siteInfo.site.business_hours && Object.keys(siteInfo.site.business_hours).length > 0;
      const hasBusinessHoursInSettings = siteInfo.settings && siteInfo.settings.business_hours && Object.keys(siteInfo.settings.business_hours).length > 0;
      
      if ((hasBusinessHoursInSite || hasBusinessHoursInSettings) && !finalPrompt.includes('## Business Hours')) {
        console.error(`⚠️ [BackgroundBuilder] ADVERTENCIA: Se esperaba incluir Business Hours pero no se encontró en el prompt final`);
      }
      
      if (siteInfo.settings.social_media && !finalPrompt.includes('## Social Media')) {
        console.error(`⚠️ [BackgroundBuilder] ADVERTENCIA: Se esperaba incluir Social Media pero no se encontró en el prompt final`);
      }
      
      if (siteInfo.settings.branding && !finalPrompt.includes('## Brand Identity')) {
        console.error(`⚠️ [BackgroundBuilder] ADVERTENCIA: Se esperaba incluir Brand Identity pero no se encontró en el prompt final`);
      }
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