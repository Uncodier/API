/**
 * Servicios para interactuar con agentes en la base de datos
 */

import { supabaseAdmin } from '@/lib/database/supabase-client';
import { isValidUUID } from '../utils/UuidUtils';

/**
 * Clase que proporciona servicios para manipular agentes
 */
export class AgentService {
  /**
   * Obtener información completa del agente desde la base de datos
   * 
   * Este método consulta la tabla 'agents' para obtener toda la información
   * del agente, incluyendo su configuración, prompts y descripción.
   */
  static async getAgentById(agentId: string): Promise<any | null> {
    try {
      if (!isValidUUID(agentId)) {
        console.log(`[AgentService] ID de agente no válido: ${agentId}`);
        return null;
      }
      
      console.log(`[AgentService] Obteniendo información del agente: ${agentId}`);
      
      // Consultar el agente en la base de datos con toda su información
      const { data, error } = await supabaseAdmin
        .from('agents')
        .select('*')
        .eq('id', agentId)
        .single();
      
      if (error) {
        console.error('[AgentService] Error al obtener información del agente:', error);
        return null;
      }
      
      if (!data) {
        console.log(`[AgentService] No se encontró el agente con ID: ${agentId}`);
        return null;
      }
      
      // Parse configuration if it's a string
      if (data.configuration && typeof data.configuration === 'string') {
        try {
          data.configuration = JSON.parse(data.configuration);
        } catch (e) {
          console.error('[AgentService] Error parsing agent configuration:', e);
        }
      }
      
      console.log(`[AgentService] Información del agente recuperada correctamente: ${agentId}`);
      
      // Devolver los datos completos del agente
      return data;
    } catch (error) {
      console.error('[AgentService] Error al obtener información del agente:', error);
      return null;
    }
  }

  /**
   * Obtener los archivos asociados a un agente desde la base de datos
   * 
   * Este método consulta la base de datos para obtener todos los archivos
   * vinculados al agente especificado a través de la relación agent_assets.
   */
  static async getAgentFiles(agentId: string): Promise<any[] | null> {
    try {
      if (!isValidUUID(agentId)) {
        console.log(`[AgentService] ID de agente no válido para obtener archivos: ${agentId}`);
        return null;
      }
      
      console.log(`[AgentService] Obteniendo archivos del agente: ${agentId}`);
      
      // Consultar la tabla agent_assets que mantiene la relación directa
      const { data: relationData, error: relationError } = await supabaseAdmin
        .from('agent_assets')
        .select('*')
        .eq('agent_id', agentId);
      
      if (relationError) {
        console.error('[AgentService] Error al consultar relaciones agent_assets:', relationError);
        return [];
      }
      
      if (!relationData || relationData.length === 0) {
        console.log(`[AgentService] No se encontraron relaciones en agent_assets para el agente: ${agentId}`);
        return [];
      }
      
      console.log(`[AgentService] Se encontraron ${relationData.length} relaciones para el agente: ${agentId}`);
      
      // Extraer los IDs de assets
      const assetIds = relationData.map(relation => relation.asset_id);
      console.log(`[AgentService] Obteniendo ${assetIds.length} assets por IDs: ${assetIds.join(', ').substring(0, 100)}...`);
      
      // Obtener los assets completos
      const { data: assetsData, error: assetsError } = await supabaseAdmin
        .from('assets')
        .select('*')
        .in('id', assetIds);
      
      if (assetsError) {
        console.error('[AgentService] Error al obtener assets:', assetsError);
        return [];
      }
      
      if (!assetsData || assetsData.length === 0) {
        console.log(`[AgentService] No se encontraron assets para los IDs de relación`);
        return [];
      }
      
      console.log(`[AgentService] Encontrados ${assetsData.length} assets para el agente`);
      return assetsData;
      
    } catch (error) {
      console.error('[AgentService] Error al obtener archivos del agente:', error);
      return [];
    }
  }

  /**
   * Leer el contenido de un archivo del agente desde el sistema de almacenamiento
   * 
   * Este método obtiene el contenido de un archivo específico asociado al agente.
   * Para archivos CSV, se asegura de que estén formateados correctamente.
   */
  static async getAgentFileContent(filePath: string): Promise<string | null> {
    try {
      console.log(`[AgentService] Obteniendo contenido del archivo: ${filePath}`);

      // Verificar primero si es una URL completa para descarga directa
      if (filePath.startsWith('http://') || filePath.startsWith('https://')) {
        console.log(`🔍 File path es una URL, intentando descarga directa: ${filePath}`);
        try {
          const response = await fetch(filePath);
          if (response.ok) {
            const content = await response.text();
            console.log(`[AgentService] Contenido obtenido exitosamente de URL directa (${content.length} bytes)`);
            
            // Si es un archivo CSV, hacer una validación rápida
            if (filePath.toLowerCase().endsWith('.csv')) {
              console.log(`[AgentService] Validando formato CSV...`);
              if (content.includes(',') && (content.includes('\n') || content.includes('\r'))) {
                console.log(`[AgentService] El contenido parece ser un CSV válido`);
                
                // Mostrar las primeras filas para debug
                const rows = content.split(/\r?\n/).filter(row => row.trim());
                if (rows.length > 0) {
                  console.log(`[AgentService] CSV tiene ${rows.length} filas. Primera fila: ${rows[0]}`);
                  if (rows.length > 1) {
                    console.log(`[AgentService] Segunda fila: ${rows[1]}`);
                  }
                }
              }
            }
            
            return content;
          }
        } catch (urlError: any) {
          console.error(`[AgentService] Error al obtener contenido de URL directa: ${urlError.message}`);
          // Continuar con otros métodos si falla
        }
      }

      // Verificar si es un UUID - podría ser un ID de asset en lugar de una ruta
      if (isValidUUID(filePath)) {
        console.log(`[AgentService] Detectado ID de asset, buscando información del archivo: ${filePath}`);
        
        // Obtener información del archivo desde la tabla assets
        const { data: assetData, error: assetError } = await supabaseAdmin
          .from('assets')
          .select('*')
          .eq('id', filePath)
          .single();
          
        if (!assetError && assetData) {
          console.log(`[AgentService] Información de asset encontrada, usando ruta: ${assetData.file_path}`);
          
          // Si el asset tiene una URL pública directa, intentar usarla primero
          if (assetData.public_url) {
            console.log(`[AgentService] El asset tiene URL pública, intentando obtener de: ${assetData.public_url}`);
            try {
              // Intentar obtener el contenido directamente de la URL pública
              const response = await fetch(assetData.public_url);
              if (response.ok) {
                const content = await response.text();
                console.log(`[AgentService] Contenido obtenido exitosamente de URL pública (${content.length} bytes)`);
                
                // Si es un archivo CSV, hacer una validación rápida
                if (assetData.file_type?.toLowerCase() === 'csv' || assetData.file_path?.toLowerCase().endsWith('.csv')) {
                  console.log(`[AgentService] Validando formato CSV...`);
                  if (content.includes(',') && (content.includes('\n') || content.includes('\r'))) {
                    console.log(`[AgentService] El contenido parece ser un CSV válido`);
                    
                    // Mostrar las primeras filas para debug
                    const rows = content.split(/\r?\n/).filter(row => row.trim());
                    if (rows.length > 0) {
                      console.log(`[AgentService] CSV tiene ${rows.length} filas. Primera fila: ${rows[0]}`);
                      if (rows.length > 1) {
                        console.log(`[AgentService] Segunda fila: ${rows[1]}`);
                      }
                    }
                  }
                }
                
                return content;
              }
            } catch (urlError: any) {
              console.error(`[AgentService] Error al obtener contenido de URL pública: ${urlError.message}`);
              // Continuar con otros métodos si falla
            }
          }
          
          filePath = assetData.file_path;
        } else {
          console.error('[AgentService] Error al obtener información del asset:', assetError);
        }
      }
      
      // Usar directamente el bucket 'assets' para archivos de agentes
      const DEFAULT_BUCKET = 'assets';
      
      console.log(`[AgentService] Intentando descargar desde bucket predeterminado: ${DEFAULT_BUCKET}, ruta: ${filePath}`);
      
      // Intentar descargar desde el bucket assets
      let { data, error } = await supabaseAdmin
        .storage
        .from(DEFAULT_BUCKET)
        .download(filePath);
      
      // Si falla, intentar con el bucket 'assets' pero con prefijo 'assets/'
      if (error && !filePath.startsWith('assets/')) {
        console.log(`[AgentService] Intentando con prefijo 'assets/' en el bucket ${DEFAULT_BUCKET}`);
        const pathWithPrefix = `assets/${filePath}`;
        ({ data, error } = await supabaseAdmin
          .storage
          .from(DEFAULT_BUCKET)
          .download(pathWithPrefix));
          
        if (!error) {
          console.log(`[AgentService] Archivo encontrado con prefijo 'assets/' en bucket ${DEFAULT_BUCKET}`);
        }
      }
      
      // Como último recurso, intentar obtener URL pública del bucket assets
      if (error) {
        try {
          console.log(`[AgentService] Intentando obtener URL pública de ${DEFAULT_BUCKET}/${filePath}`);
          const { data: urlData } = await supabaseAdmin
            .storage
            .from(DEFAULT_BUCKET)
            .getPublicUrl(filePath);
            
          if (urlData && urlData.publicUrl) {
            console.log(`[AgentService] Obteniendo contenido de URL pública: ${urlData.publicUrl}`);
            const response = await fetch(urlData.publicUrl);
            if (response.ok) {
              const content = await response.text();
              console.log(`[AgentService] Contenido obtenido de URL pública (${content.length} bytes)`);
              return content;
            }
          }
        } catch (urlError) {
          console.error('[AgentService] Error al obtener URL pública:', urlError);
        }
      }
      
      if (error) {
        console.error('[AgentService] Error al obtener contenido del archivo:', error);
        return null;
      }
      
      try {
        // Convertir el blob a texto
        if (!data) {
          console.error('[AgentService] Datos nulos recibidos de storage');
          return null;
        }
        
        const fileContent = await data.text();
        
        // Para archivos CSV, hacer validación adicional
        if (filePath.toLowerCase().endsWith('.csv')) {
          console.log(`[AgentService] Validando formato CSV...`);
          if (fileContent.includes(',') && (fileContent.includes('\n') || fileContent.includes('\r'))) {
            console.log(`[AgentService] El contenido parece ser un CSV válido`);
            
            // Mostrar las primeras filas para debug
            const rows = fileContent.split(/\r?\n/).filter(row => row.trim());
            if (rows.length > 0) {
              console.log(`[AgentService] CSV tiene ${rows.length} filas. Primera fila: ${rows[0]}`);
              if (rows.length > 1) {
                console.log(`[AgentService] Segunda fila: ${rows[1]}`);
              }
            }
          } else {
            console.warn(`[AgentService] El contenido no parece tener formato CSV válido`);
          }
        }
        
        return fileContent;
      } catch (textError) {
        console.error('[AgentService] Error al convertir blob a texto:', textError);
        return null;
      }
    } catch (error) {
      console.error('[AgentService] Error al obtener contenido del archivo:', error);
      return null;
    }
  }
  
  /**
   * Obtener información completa de un sitio desde la base de datos
   * 
   * Este método consulta la tabla 'sites' para obtener toda la información
   * del sitio, incluyendo nombre, descripción, recursos y configuración.
   */
  static async getSiteById(siteId: string): Promise<any | null> {
    try {
      if (!isValidUUID(siteId)) {
        console.log(`[AgentService] ID de sitio no válido: ${siteId}`);
        return null;
      }
      
      console.log(`[AgentService] Obteniendo información del sitio: ${siteId}`);
      
      // Consultar el sitio en la base de datos con toda su información
      const { data, error } = await supabaseAdmin
        .from('sites')
        .select('*')
        .eq('id', siteId)
        .single();
      
      if (error) {
        console.error('[AgentService] Error al obtener información del sitio:', error);
        return null;
      }
      
      if (!data) {
        console.log(`[AgentService] No se encontró el sitio con ID: ${siteId}`);
        return null;
      }
      
      // Convertir campos JSON si vienen como string
      const jsonFields = ['resource_urls', 'competitors', 'tracking'];
      jsonFields.forEach(field => {
        if (data[field] && typeof data[field] === 'string') {
          try {
            data[field] = JSON.parse(data[field]);
          } catch (e) {
            console.error(`[AgentService] Error parsing site ${field}:`, e);
          }
        }
      });
      
      console.log(`[AgentService] Información del sitio recuperada correctamente: ${siteId}`);
      
      return data;
    } catch (error) {
      console.error('[AgentService] Error al obtener información del sitio:', error);
      return null;
    }
  }
  
  /**
   * Obtener configuración completa de un sitio desde la base de datos
   * 
   * Este método consulta la tabla 'settings' para obtener toda la configuración
   * de un sitio, incluyendo información sobre la empresa, productos, servicios, etc.
   */
  static async getSiteSettingsById(siteId: string): Promise<any | null> {
    try {
      if (!isValidUUID(siteId)) {
        console.log(`[AgentService] ID de sitio no válido para obtener configuración: ${siteId}`);
        return null;
      }
      
      console.log(`[AgentService] Obteniendo configuración del sitio: ${siteId}`);
      
      // Consultar la configuración del sitio en la base de datos
      const { data, error } = await supabaseAdmin
        .from('settings')
        .select('*')
        .eq('site_id', siteId)
        .single();
      
      if (error) {
        console.error('[AgentService] Error al obtener configuración del sitio:', error);
        return null;
      }
      
      if (!data) {
        console.log(`[AgentService] No se encontró configuración para el sitio con ID: ${siteId}`);
        return null;
      }
      
      // Convertir campos JSON si vienen como string
      const jsonFields = [
        'products', 'services', 'swot', 'locations', 'marketing_budget', 
        'marketing_channels', 'social_media', 'goals',
        'tracking', 'team_members', 'team_roles', 
        'org_structure'
      ];
      
      jsonFields.forEach(field => {
        if (data[field] && typeof data[field] === 'string') {
          try {
            data[field] = JSON.parse(data[field]);
          } catch (e) {
            console.error(`[AgentService] Error parsing site_settings ${field}:`, e);
          }
        }
      });
      
      console.log(`[AgentService] Configuración del sitio recuperada correctamente: ${siteId}`);
      
      return data;
    } catch (error) {
      console.error('[AgentService] Error al obtener configuración del sitio:', error);
      return null;
    }
  }

  /**
   * Obtener contenido de copywriting de un sitio desde la base de datos
   * 
   * Este método consulta la tabla 'copywriting' para obtener todo el contenido
   * de copywriting asociado a un sitio específico.
   */
  static async getCopywritingBySiteId(siteId: string): Promise<any[] | null> {
    try {
      if (!isValidUUID(siteId)) {
        console.log(`[AgentService] ID de sitio no válido para obtener copywriting: ${siteId}`);
        return null;
      }
      
      console.log(`[AgentService] Obteniendo copywriting del sitio: ${siteId}`);
      
      // Consultar el copywriting del sitio en la base de datos (solo approved)
      const { data, error } = await supabaseAdmin
        .from('copywriting')
        .select('*')
        .eq('site_id', siteId)
        .eq('status', 'approved') // Solo incluir contenido aprobado
        .order('created_at', { ascending: false }); // Ordenar por más reciente primero
      
      if (error) {
        console.error('[AgentService] Error al obtener copywriting del sitio:', error);
        return null;
      }
      
      if (!data || data.length === 0) {
        console.log(`[AgentService] No se encontró copywriting para el sitio con ID: ${siteId}`);
        return [];
      }
      
      console.log(`[AgentService] Copywriting aprobado del sitio recuperado correctamente: ${siteId} (${data.length} elementos aprobados)`);
      
      return data;
    } catch (error) {
      console.error('[AgentService] Error al obtener copywriting del sitio:', error);
      return null;
    }
  }
} 