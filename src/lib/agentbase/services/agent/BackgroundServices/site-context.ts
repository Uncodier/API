import { formatBrandIdentity } from './branding-context';
import { compactConfiguredOfferings } from './compact-offerings';
import { formatSiteCommunication } from './site-communication-context';
import { formatSiteLocations } from './site-locations-context';

export interface SitePromptInfo {
  site: any | null;
  settings: any | null;
  copywriting?: any[] | null;
}

export function createSiteInfoSection(siteInfo: SitePromptInfo | undefined, formatCustomerJourney: (value: any) => string): string {
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

    // Configured names are background, never a full/live catalog or private price data.
    siteSection += compactConfiguredOfferings(siteInfo.settings.products, siteInfo.settings.services);

    siteSection += formatBrandIdentity(siteInfo.settings.branding);
    siteSection += formatSiteLocations(siteInfo.settings);

    if (siteInfo.settings.marketing_channels) {
      // Reduced verbosity
      siteSection += `\n## Marketing Channels\n${JSON.stringify(siteInfo.settings.marketing_channels)}\n`;
    }

    siteSection += formatSiteCommunication(siteInfo.settings);

    // Customer Journey Tactics (CRITICAL INFORMATION)
    if (siteInfo.settings.customer_journey) {
      // Reduced verbosity
      siteSection += formatCustomerJourney(siteInfo.settings.customer_journey);
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
