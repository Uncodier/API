import { supabaseAdmin } from '@/lib/database/supabase-client';
import { normalizePhoneForSearch, normalizePhoneForStorage } from '@/lib/utils/phone-normalizer';
import { v4 as uuidv4 } from 'uuid';

interface WhatsAppLeadResult {
  leadId: string | null;
  conversationId: string | null;
  isNewLead: boolean;
  isNewConversation: boolean;
}

interface WhatsAppLeadParams {
  phoneNumber: string;
  senderName?: string;
  siteId: string;
  userId?: string;
  businessAccountId?: string;
}

export class WhatsAppLeadService {
  
  /**
   * Busca o crea un lead basado en el número de teléfono de WhatsApp
   * y busca una conversación reciente de WhatsApp (últimos 15 días)
   */
  static async findOrCreateLeadAndConversation(params: WhatsAppLeadParams): Promise<WhatsAppLeadResult> {
    const { phoneNumber, senderName, siteId, userId, businessAccountId } = params;
    
    try {
      console.log(`📱 [WhatsAppLeadService] Procesando lead para: ${phoneNumber.substring(0, 6)}*** en sitio ${siteId}`);
      
      // 1. Buscar lead existente por número de teléfono
      let leadId = await this.findLeadByPhone(phoneNumber, siteId);
      let isNewLead = false;
      
      if (!leadId) {
        // 2. Crear nuevo lead si no existe
        leadId = await this.createWhatsAppLead(phoneNumber, senderName, siteId, userId);
        isNewLead = true;
        console.log(`➕ [WhatsAppLeadService] Nuevo lead creado: ${leadId}`);
      } else {
        console.log(`✅ [WhatsAppLeadService] Lead existente encontrado: ${leadId}`);
      }
      
      if (!leadId) {
        console.error(`❌ [WhatsAppLeadService] No se pudo obtener o crear lead para ${phoneNumber}`);
        return {
          leadId: null,
          conversationId: null,
          isNewLead: false,
          isNewConversation: false
        };
      }
      
      // 3. Buscar conversación reciente de WhatsApp (últimos 15 días)
      const conversationId = await this.findRecentWhatsAppConversation(leadId, siteId);
      let isNewConversation = false;
      
      if (!conversationId) {
        console.log(`📞 [WhatsAppLeadService] No se encontró conversación reciente de WhatsApp para lead ${leadId}`);
        isNewConversation = true;
      } else {
        console.log(`💬 [WhatsAppLeadService] Conversación de WhatsApp encontrada: ${conversationId}`);
      }
      
      return {
        leadId,
        conversationId,
        isNewLead,
        isNewConversation
      };
      
    } catch (error) {
      console.error(`❌ [WhatsAppLeadService] Error procesando lead para WhatsApp:`, error);
      return {
        leadId: null,
        conversationId: null,
        isNewLead: false,
        isNewConversation: false
      };
    }
  }
  
  /**
   * Busca un lead por número de teléfono en un sitio específico
   * Utiliza normalización para encontrar números equivalentes en diferentes formatos
   */
  private static async findLeadByPhone(phoneNumber: string, siteId: string): Promise<string | null> {
    try {
      console.log(`🔍 [WhatsAppLeadService] Buscando lead por teléfono: ${phoneNumber.substring(0, 6)}*** en sitio ${siteId}`);
      
      // Generar variantes normalizadas del número para búsqueda más flexible
      const phoneVariants = normalizePhoneForSearch(phoneNumber);
      console.log(`📞 [WhatsAppLeadService] Variantes generadas: ${phoneVariants.join(', ')}`);
      
      if (phoneVariants.length === 0) {
        console.log(`⚠️ [WhatsAppLeadService] No se pudieron generar variantes válidas para el teléfono: ${phoneNumber}`);
        return null;
      }
      
      let query = supabaseAdmin
        .from('leads')
        .select('id')
        .eq('site_id', siteId);
      
      // Usar IN para evitar issues de encoding con '+' en OR queries
      query = query.in('phone', phoneVariants);
      
      const { data, error } = await query
        .order('created_at', { ascending: false })
        .limit(1);
      
      if (error) {
        console.error(`❌ [WhatsAppLeadService] Error buscando lead por teléfono:`, error);
        return null;
      }
      
      if (!data || data.length === 0) {
        console.log(`⚠️ [WhatsAppLeadService] No se encontró lead con teléfono ${phoneNumber.substring(0, 6)}*** en sitio ${siteId}`);
        return null;
      }
      
      console.log(`✅ [WhatsAppLeadService] Lead encontrado: ${data[0].id}`);
      return data[0].id;
    } catch (error) {
      console.error(`❌ [WhatsAppLeadService] Excepción buscando lead por teléfono:`, error);
      return null;
    }
  }
  
  /**
   * Crea un nuevo lead para WhatsApp
   */
  private static async createWhatsAppLead(phoneNumber: string, senderName?: string, siteId?: string, userId?: string): Promise<string | null> {
    try {
      console.log(`➕ [WhatsAppLeadService] Creando nuevo lead para WhatsApp: ${phoneNumber.substring(0, 6)}***`);
      
      // Preparar datos del lead
      const normalizedPhone = normalizePhoneForStorage(phoneNumber);
      const leadData: any = {
        phone: normalizedPhone,
        origin: 'whatsapp',
        status: 'contacted'
      };
      
      console.log(`📞 [WhatsAppLeadService] Teléfono normalizado para almacenamiento: "${phoneNumber}" -> "${normalizedPhone}"`);
      
      // Agregar nombre si está disponible
      if (senderName && senderName.trim()) {
        leadData.name = senderName.trim();
      } else {
        // Usar nombre por defecto basado en el número
        leadData.name = `Lead ${phoneNumber.substring(-4)}`;
      }
      
      // Agregar site_id y user_id si están disponibles
      if (siteId) {
        leadData.site_id = siteId;
        
        // Si no tenemos userId, intentar obtenerlo del sitio
        if (!userId) {
          try {
            const { data: site, error: siteError } = await supabaseAdmin
              .from('sites')
              .select('user_id')
              .eq('id', siteId)
              .single();
            
            if (!siteError && site) {
              leadData.user_id = site.user_id;
              console.log(`👤 [WhatsAppLeadService] Usando user_id del sitio: ${site.user_id}`);
            }
          } catch (e) {
            console.warn(`⚠️ [WhatsAppLeadService] No se pudo obtener user_id del sitio ${siteId}`);
          }
        } else {
          leadData.user_id = userId;
        }
      }
      
      console.log(`📦 [WhatsAppLeadService] Datos para crear lead:`, {
        ...leadData,
        phone: phoneNumber.substring(0, 6) + '***'
      });
      
      const { data, error } = await supabaseAdmin
        .from('leads')
        .insert([leadData])
        .select()
        .single();
      
      if (error) {
        console.error(`❌ [WhatsAppLeadService] Error creando lead:`, error);
        
        // Si es error de duplicado, intentar buscar el lead existente
        if (error.code === '23505') {
          console.log(`🔄 [WhatsAppLeadService] Error de duplicado, buscando lead existente...`);
          return await this.findLeadByPhone(phoneNumber, siteId || '');
        }
        
        return null;
      }
      
      if (!data || !data.id) {
        console.error(`❌ [WhatsAppLeadService] No se recibió ID para el lead creado`);
        return null;
      }
      
      console.log(`✅ [WhatsAppLeadService] Lead creado exitosamente: ${data.id}`);
      return data.id;
      
    } catch (error) {
      console.error(`❌ [WhatsAppLeadService] Excepción creando lead:`, error);
      return null;
    }
  }
  
  /**
   * Busca conversación reciente de WhatsApp para un lead (últimos 15 días)
   */
  private static async findRecentWhatsAppConversation(leadId: string, siteId: string): Promise<string | null> {
    try {
      console.log(`💬 [WhatsAppLeadService] Buscando conversación reciente de WhatsApp para lead: ${leadId}`);
      
      // Calcular fecha límite (15 días atrás)
      const fifteenDaysAgo = new Date();
      fifteenDaysAgo.setDate(fifteenDaysAgo.getDate() - 15);
      const dateLimit = fifteenDaysAgo.toISOString();
      
      // Buscar conversaciones de WhatsApp del lead en los últimos 15 días
      const { data, error } = await supabaseAdmin
        .from('conversations')
        .select('id, created_at, custom_data, channel')
        .eq('lead_id', leadId)
        .eq('site_id', siteId)
        .gte('created_at', dateLimit)
        .order('created_at', { ascending: false });
      
      if (error) {
        console.error(`❌ [WhatsAppLeadService] Error buscando conversaciones:`, error);
        return null;
      }
      
      if (!data || data.length === 0) {
        console.log(`⚠️ [WhatsAppLeadService] No se encontraron conversaciones recientes para lead ${leadId}`);
        return null;
      }
      
      // Filtrar por conversaciones de WhatsApp
      const whatsappConversations = data.filter(conv => {
        // Verificar en custom_data.channel
        if (conv.custom_data && conv.custom_data.channel === 'whatsapp') {
          return true;
        }
        
        // Verificar en campo channel directo
        if (conv.channel === 'whatsapp') {
          return true;
        }
        
        // Verificar en custom_data.source (formato anterior)
        if (conv.custom_data && conv.custom_data.source === 'whatsapp') {
          return true;
        }
        
        return false;
      });
      
      if (whatsappConversations.length === 0) {
        console.log(`⚠️ [WhatsAppLeadService] No se encontraron conversaciones de WhatsApp recientes para lead ${leadId}`);
        return null;
      }
      
      // Retornar la conversación más reciente
      const recentConversation = whatsappConversations[0];
      console.log(`✅ [WhatsAppLeadService] Conversación de WhatsApp encontrada: ${recentConversation.id} (${recentConversation.created_at})`);
      
      return recentConversation.id;
      
    } catch (error) {
      console.error(`❌ [WhatsAppLeadService] Excepción buscando conversación de WhatsApp:`, error);
      return null;
    }
  }
  
  /**
   * Valida si un UUID es válido
   */
  private static isValidUUID(uuid: string): boolean {
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    return uuidRegex.test(uuid);
  }
} 
