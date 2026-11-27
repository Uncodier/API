/**
 * BackgroundBuilder.ts
 * Clase para construir el texto de background del agente de manera estructurada
 */

import { buildDateContextSection } from '@/lib/timezone';
import { createSiteInfoSection, type SitePromptInfo } from './site-context';

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
    siteInfo?: SitePromptInfo,
    activeCampaigns?: Array<{
      title: string;
      description?: string;
    }>,
    timezone?: string
  ): string {
    // Reduced verbosity - only log essentials
    console.log(`🧩 [BackgroundBuilder] Building prompt for ${name}`);
    
    // Construir el prompt de forma estructurada por bloques
    const sections = [
      this.createServerDateSection(timezone),
      this.createIdentitySection(id, name),
      this.createBackstorySection(backstory),
      this.createDescriptionSection(description),
      this.createCapabilitiesSection(capabilities),
      this.createInstructionsSection(name),
      this.createSystemSection(systemPrompt),
      this.createCustomInstructionsSection(agentPrompt),
      createSiteInfoSection(siteInfo, this.createCustomerJourneySection),
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
   * Injects server UTC plus the client's local clock and precomputed UTC filter bounds.
   */
  private static createServerDateSection(timezone?: string): string {
    return buildDateContextSection(timezone);
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
4. Your name is "${name}" - whenever asked about your name, identity or what you are, respond with this name.
5. Whenever there is a requirement and the user requests changes, these changes must be applied to the requirement/plan. DO NOT attempt to execute the steps directly. You can make changes to the plan (as the orchestrator listens to this), but never try to execute the steps directly if there is an active requirement.
6. For any complex request or new task, ALWAYS use the skill lookup tool at the beginning to search for relevant skills or procedures to follow BEFORE proceeding.`;
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
    siteInfo?: SitePromptInfo
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
4. Your name is "${name}" - whenever asked about your name, identity or what you are, respond with this name.
5. Whenever there is a requirement and the user requests changes, these changes must be applied to the requirement/plan. DO NOT attempt to execute the steps directly. You can make changes to the plan (as the orchestrator listens to this), but never try to execute the steps directly if there is an active requirement.
6. For any complex request or new task, ALWAYS use the skill lookup tool at the beginning to search for relevant skills or procedures to follow BEFORE proceeding.`;
    
    console.log(`⚠️ [BackgroundBuilder] Background de emergencia generado (${emergencyBackground.length} caracteres)`);
    return emergencyBackground;
  }
} 