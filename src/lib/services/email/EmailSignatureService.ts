import { supabaseAdmin } from '@/lib/database/supabase-client';

export interface SignatureData {
  companyName?: string;
  siteUrl?: string;
  logoUrl?: string;
  about?: string;
  companySize?: string;
  industry?: string;
  teamMembers?: Array<{
    name: string;
    role: string;
    email?: string;
    phone?: string;
  }>;
  locations?: Array<{
    address: string;
    phone?: string;
    type?: string;
  }>;
  socialMedia?: {
    website?: string;
    linkedin?: string;
    twitter?: string;
    facebook?: string;
  };
  emailAddress?: string;
}

export interface GeneratedSignature {
  plainText: string;
  formatted: string;
}

export class EmailSignatureService {
  /**
   * Genera una firma para el agente basada en la configuración del sitio
   */
  static async generateAgentSignature(siteId: string, agentName?: string): Promise<GeneratedSignature> {
    try {
      const signatureData = await this.getSignatureData(siteId);
      return this.buildSignature(signatureData, agentName);
    } catch (error) {
      console.error('Error generando firma del agente:', error);
      // Retornar una firma básica en caso de error
      return this.buildBasicSignature(agentName);
    }
  }

  /**
   * Obtiene los datos necesarios para la firma desde settings y sites
   */
  private static async getSignatureData(siteId: string): Promise<SignatureData> {
    const signatureData: SignatureData = {};

    try {
      // Obtener información básica del sitio incluyendo logo
      const { data: siteData, error: siteError } = await supabaseAdmin
        .from('sites')
        .select('name, url, description, logo_url')
        .eq('id', siteId)
        .single();

      if (!siteError && siteData) {
        signatureData.companyName = siteData.name;
        signatureData.siteUrl = siteData.url;
        signatureData.logoUrl = siteData.logo_url;
        if (siteData.description) {
          signatureData.about = siteData.description;
        }
      }

      // Obtener configuración detallada desde settings
      const { data: settings, error: settingsError } = await supabaseAdmin
        .from('settings')
        .select('*')
        .eq('site_id', siteId)
        .single();

      if (!settingsError && settings) {
        signatureData.companySize = settings.company_size;
        signatureData.industry = settings.industry;
        
        // Priorizar about de settings sobre site description
        if (settings.about) {
          signatureData.about = settings.about;
        }

        // Procesar campos JSON
        if (settings.team_members) {
          try {
            signatureData.teamMembers = typeof settings.team_members === 'string' 
              ? JSON.parse(settings.team_members)
              : settings.team_members;
          } catch (e) {
            console.warn('Error parsing team_members:', e);
          }
        }

        if (settings.locations) {
          try {
            signatureData.locations = typeof settings.locations === 'string'
              ? JSON.parse(settings.locations)
              : settings.locations;
          } catch (e) {
            console.warn('Error parsing locations:', e);
          }
        }

        if (settings.social_media) {
          try {
            signatureData.socialMedia = typeof settings.social_media === 'string'
              ? JSON.parse(settings.social_media)
              : settings.social_media;
          } catch (e) {
            console.warn('Error parsing social_media:', e);
          }
        }

        // Obtener email configurado
        if (settings.channels?.email?.email) {
          signatureData.emailAddress = settings.channels.email.email;
        }
      }

    } catch (error) {
      console.error('Error obteniendo datos para firma:', error);
    }

    return signatureData;
  }

  /**
   * Construye la firma con los datos disponibles
   */
  private static buildSignature(data: SignatureData, agentName?: string): GeneratedSignature {
    // Validar y limpiar el nombre del agente para evitar duplicaciones
    let cleanAgentName = agentName;
    if (agentName && this.isValidEmail(agentName)) {
      cleanAgentName = undefined;
    }

    // Construir la firma de texto plano
    const plainText = this.buildPlainTextSignature(data, cleanAgentName);

    // Construir la firma HTML
    const formatted = this.buildHtmlSignature(data, cleanAgentName);

    return {
      plainText,
      formatted
    };
  }

  /**
   * Construye una firma simple en texto plano
   */
  private static buildPlainTextSignature(data: SignatureData, agentName?: string): string {
    const lines: string[] = [];
    
    // Nombre del agente
    if (agentName?.trim()) {
      lines.push(agentName.trim());
    }

    // Nombre de la empresa (solo si es diferente del agente)
    if (data.companyName && data.companyName !== agentName) {
      lines.push(data.companyName);
    }

    // Tweet pitch
    if (data.about && data.about.length < 150) {
      lines.push(`"${data.about}"`);
    }

    // Email
    if (data.emailAddress) {
      lines.push(`Email: ${data.emailAddress}`);
    }

    // Website
    if (data.siteUrl) {
      lines.push(`Web: ${data.siteUrl}`);
    }

    // Teléfono
    const phone = this.extractContactPhone(data);
    if (phone) {
      lines.push(`Tel: ${phone}`);
    }

    // Si no hay contenido, usar genérico
    if (lines.length === 0) {
      lines.push('Equipo de Atención al Cliente');
    }

    return lines.join('\n');
  }

  /**
   * Construye una firma HTML simple y limpia en formato de 2 columnas
   */
  private static buildHtmlSignature(data: SignatureData, agentName?: string): string {
    // Solo mostrar el nombre del agente si existe y es diferente del nombre de la empresa
    const shouldShowAgent = agentName?.trim() && agentName !== data.companyName;
    const shouldShowCompany = data.companyName;
    
    // Contenido de la columna derecha (información)
    const rightColumnContent: string[] = [];

    // Nombre del agente
    if (shouldShowAgent) {
      rightColumnContent.push(`<div style="font-weight: 600; font-size: 16px; color: #333; margin-bottom: 4px;">${agentName}</div>`);
    }

    // Nombre de la empresa con about en la misma línea
    if (shouldShowCompany) {
      let companyLine = `<div style="font-size: 14px; color: #007bff; margin-bottom: 8px;">${data.companyName}`;
      
      // Agregar about en la misma línea si existe y es corto
      if (data.about && data.about.length < 150) {
        companyLine += ` - <span style="font-style: italic; color: #666;">"${data.about}"</span>`;
      }
      
      companyLine += `</div>`;
      rightColumnContent.push(companyLine);
    }

    // Email
    if (data.emailAddress) {
      rightColumnContent.push(`<div style="font-size: 13px; margin: 2px 0;">📧 <a href="mailto:${data.emailAddress}" style="color: #007bff; text-decoration: none;">${data.emailAddress}</a></div>`);
    }

    // Website
    if (data.siteUrl) {
      rightColumnContent.push(`<div style="font-size: 13px; margin: 2px 0;">🌐 <a href="${data.siteUrl}" style="color: #007bff; text-decoration: none;">${data.siteUrl}</a></div>`);
    }

    // Teléfono
    const phone = this.extractContactPhone(data);
    if (phone) {
      rightColumnContent.push(`<div style="font-size: 13px; margin: 2px 0;">📞 <a href="tel:${phone}" style="color: #333; text-decoration: none;">${phone}</a></div>`);
    }

    // Si no hay contenido de información, usar genérico
    if (rightColumnContent.length === 0) {
      rightColumnContent.push(`<div style="font-weight: 600; font-size: 16px; color: #333;">Equipo de Atención al Cliente</div>`);
    }

    // Estructura de 2 columnas: logo centrado verticalmente + información
    if (data.logoUrl) {
      return `
        <table style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; border-collapse: collapse; width: 100%; max-width: 400px;">
          <tr>
            <td style="vertical-align: middle; padding-right: 15px; width: 60px; text-align: center;">
              <img src="${data.logoUrl}" alt="Logo" style="width: 50px; height: 50px; object-fit: contain;">
            </td>
            <td style="vertical-align: middle;">
              ${rightColumnContent.join('')}
            </td>
          </tr>
        </table>
      `;
    } else {
      // Sin logo, solo información
      return `<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 14px; line-height: 1.4; max-width: 300px;">${rightColumnContent.join('')}</div>`;
    }
  }

  /**
   * Extrae el número de teléfono principal de los datos disponibles
   */
  private static extractContactPhone(data: SignatureData): string | null {
    // Buscar en ubicaciones primero
    if (data.locations && data.locations.length > 0) {
      // Buscar ubicación principal con teléfono
      const mainLocation = data.locations.find(loc => 
        (loc.type === 'headquarters' || loc.type === 'main' || loc.type === 'principal') && loc.phone
      );
      
      if (mainLocation && mainLocation.phone) {
        return mainLocation.phone;
      }
      
      // Si no hay ubicación principal con teléfono, buscar cualquier ubicación con teléfono
      for (const location of data.locations) {
        if (location.phone) {
          return location.phone;
        }
      }
    }

    // Buscar en miembros del equipo
    if (data.teamMembers && data.teamMembers.length > 0) {
      for (const member of data.teamMembers) {
        if (member.phone) {
          return member.phone;
        }
      }
    }

    return null;
  }

  /**
   * Construye una firma básica cuando no hay datos disponibles
   */
  private static buildBasicSignature(agentName?: string): GeneratedSignature {
    const name = agentName || 'Equipo de Atención al Cliente';
    const plainText = name;
    const formatted = `<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 14px; line-height: 1.4; max-width: 300px;"><div style="font-weight: 600; font-size: 16px; color: #333;">${name}</div></div>`;

    return {
      plainText,
      formatted
    };
  }

  /**
   * Valida que el siteId sea válido
   */
  private static isValidUUID(uuid: string): boolean {
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    return uuidRegex.test(uuid);
  }

  private static isValidEmail(email: string): boolean {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
  }
} 