export function formatSiteCommunication(settings: any): string {
  let siteSection = '';
  // Channels - información pública de canales de comunicación
  if (settings.channels) {
    // Reduced verbosity
    try {
      const channelsData = typeof settings.channels === 'string'
        ? JSON.parse(settings.channels)
        : settings.channels;

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
      siteSection += `\n## Communication Channels\n${JSON.stringify(settings.channels)}\n`;
    }
  }

  if (settings.social_media) {
    // Reduced verbosity

    // Parsear social_media si es string (con try/catch preventivo)
    let socialMediaData: any = null;
    try {
      socialMediaData = typeof settings.social_media === 'string'
        ? JSON.parse(settings.social_media)
        : settings.social_media;
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
  return siteSection;
}
