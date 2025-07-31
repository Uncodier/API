/**
 * Funciones de base de datos para lead generation
 */

import { supabaseAdmin } from '@/lib/database/supabase-client';
import { v4 as uuidv4 } from 'uuid';
import { LeadData, SegmentData } from './search-prompt-generator';
import { getSegmentsBySite } from '@/lib/database/segment-db';

/**
 * Función para validar UUIDs
 */
export function isValidUUID(uuid: string): boolean {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(uuid);
}

/**
 * Función para obtener segmentos disponibles de un sitio
 */
export async function getAvailableSegments(siteId: string, userId: string): Promise<SegmentData[]> {
  try {
    console.log(`🔍 Obteniendo segmentos disponibles para sitio: ${siteId}`);
    
    const segments = await getSegmentsBySite(siteId, userId);
    
    if (!segments || segments.length === 0) {
      console.log('⚠️ No se encontraron segmentos para el sitio');
      return [];
    }
    
    console.log(`✅ Encontrados ${segments.length} segmentos disponibles`);
    
    // Convertir a formato SegmentData
    return segments.map(segment => ({
      id: segment.id,
      name: segment.name,
      description: segment.description || undefined,
      audience: segment.audience || undefined,
      size: segment.size || undefined
    }));
  } catch (error) {
    console.error('Error al obtener segmentos disponibles:', error);
    return [];
  }
}

/**
 * Función para obtener leads convertidos y no convertidos por segmento
 */
export async function getLeadsBySegmentAndStatus(siteId: string): Promise<{
  convertedLeads: LeadData[],
  nonConvertedLeads: LeadData[],
  segments: SegmentData[]
}> {
  try {
    console.log(`🔍 Obteniendo leads por segmento para sitio: ${siteId}`);
    
    // Obtener todos los segmentos activos del sitio
    const { data: segments, error: segmentsError } = await supabaseAdmin
      .from('segments')
      .select('*')
      .eq('site_id', siteId)
      .eq('is_active', true)
      .order('created_at', { ascending: false });
    
    if (segmentsError) {
      console.error('Error al obtener segmentos:', segmentsError);
      return { convertedLeads: [], nonConvertedLeads: [], segments: [] };
    }
    
    if (!segments || segments.length === 0) {
      console.log('⚠️ No se encontraron segmentos activos');
      return { convertedLeads: [], nonConvertedLeads: [], segments: [] };
    }
    
    console.log(`📊 Encontrados ${segments.length} segmentos activos`);
    
    const convertedLeads: LeadData[] = [];
    const nonConvertedLeads: LeadData[] = [];
    
    // Para cada segmento, obtener leads convertidos y no convertidos
    for (const segment of segments) {
      // Leads convertidos (status = 'converted')
      const { data: converted, error: convertedError } = await supabaseAdmin
        .from('leads')
        .select('*, address, company, metadata')
        .eq('site_id', siteId)
        .eq('segment_id', segment.id)
        .eq('status', 'converted')
        .order('created_at', { ascending: false })
        .limit(5);
      
      if (!convertedError && converted) {
        convertedLeads.push(...converted.map(lead => ({ ...lead, segment_name: segment.name })));
      }
      
      // Leads no convertidos (status != 'converted')
      const { data: nonConverted, error: nonConvertedError } = await supabaseAdmin
        .from('leads')
        .select('*, address, company, metadata')
        .eq('site_id', siteId)
        .eq('segment_id', segment.id)
        .neq('status', 'converted')
        .order('created_at', { ascending: false })
        .limit(5);
      
      if (!nonConvertedError && nonConverted) {
        nonConvertedLeads.push(...nonConverted.map(lead => ({ ...lead, segment_name: segment.name })));
      }
    }
    
    console.log(`✅ Obtenidos ${convertedLeads.length} leads convertidos y ${nonConvertedLeads.length} leads no convertidos`);
    
    return {
      convertedLeads,
      nonConvertedLeads,
      segments
    };
    
  } catch (error) {
    console.error('Error al obtener leads por segmento:', error);
    return { convertedLeads: [], nonConvertedLeads: [], segments: [] };
  }
}

/**
 * Función para obtener o crear agent_memory para lead_generation
 * MODIFICADO: Ya no usa DEFAULT_CITIES - el agente determina las ciudades 100%
 */
export async function getOrCreateLeadGenMemory(agentId: string, userId: string): Promise<{
  usedCities: string[],
  usedRegions: { [key: string]: string[] },
  usedSegments: string[],
  usedSegmentsByRegion: { [key: string]: string[] },
  memoryId: string
}> {
  try {
    console.log(`🧠 Obteniendo memoria de lead_generation para agente: ${agentId}`);
    
    // Buscar memoria existente
    const { data: existingMemory, error: memoryError } = await supabaseAdmin
      .from('agent_memories')
      .select('*')
      .eq('agent_id', agentId)
      .eq('type', 'lead_generation')
      .eq('key', 'lead_generation')
      .order('created_at', { ascending: false })
      .limit(1)
      .single();
    
    if (memoryError && memoryError.code !== 'PGRST116') { // PGRST116 = no rows found
      console.error('Error al obtener memoria de agente:', memoryError);
    }
    
    let usedCities: string[] = [];
    let usedRegions: { [key: string]: string[] } = {};
    let usedSegments: string[] = [];
    let usedSegmentsByRegion: { [key: string]: string[] } = {};
    let memoryId: string;
    
    if (existingMemory) {
      console.log(`✅ Memoria existente encontrada: ${existingMemory.id}`);
      const memoryData = existingMemory.data || {};
      usedCities = memoryData.usedCities || [];
      usedRegions = memoryData.usedRegions || {};
      usedSegments = memoryData.usedSegments || [];
      usedSegmentsByRegion = memoryData.usedSegmentsByRegion || {};
      memoryId = existingMemory.id;
    } else {
      console.log(`🆕 Creando nueva memoria de lead_generation`);
      memoryId = uuidv4();
      usedCities = [];
      usedRegions = {};
      usedSegments = [];
      usedSegmentsByRegion = {};
    }
    
    // Actualizar o crear memoria (sin modificar las ciudades - solo las devuelve)
    const memoryData = {
      id: memoryId,
      agent_id: agentId,
      user_id: userId,
      type: 'lead_generation',
      key: 'lead_generation',
      data: {
        usedCities: usedCities,
        usedRegions: usedRegions,
        usedSegments: usedSegments,
        usedSegmentsByRegion: usedSegmentsByRegion,
        lastUpdated: new Date().toISOString(),
        agentDeterminedCities: true // Indicador de que el agente determina las ciudades
      },
      metadata: {
        purpose: 'track_agent_determined_targeting_history',
        cityStrategy: 'agent_determined',
        regionStrategy: 'agent_determined'
      },
      created_at: existingMemory?.created_at || new Date().toISOString(),
      updated_at: new Date().toISOString(),
      access_count: (existingMemory?.access_count || 0) + 1,
      last_accessed: new Date().toISOString()
    };
    
    if (existingMemory) {
      // Actualizar memoria existente
      const { error: updateError } = await supabaseAdmin
        .from('agent_memories')
        .update(memoryData)
        .eq('id', memoryId);
      
      if (updateError) {
        console.error('Error al actualizar memoria:', updateError);
      } else {
        console.log(`📝 Memoria actualizada - agente determinará ciudades`);
      }
    } else {
      // Crear nueva memoria
      const { error: insertError } = await supabaseAdmin
        .from('agent_memories')
        .insert([memoryData]);
      
      if (insertError) {
        console.error('Error al crear memoria:', insertError);
      } else {
        console.log(`📝 Nueva memoria creada - agente determinará ciudades`);
      }
    }
    
    return {
      usedCities: usedCities,
      usedRegions: usedRegions,
      usedSegments: usedSegments,
      usedSegmentsByRegion: usedSegmentsByRegion,
      memoryId
    };
    
  } catch (error) {
    console.error('Error en getOrCreateLeadGenMemory:', error);
    // Retornar valores por defecto en caso de error
    return {
      usedCities: [],
      usedRegions: {},
      usedSegments: [],
      usedSegmentsByRegion: {},
      memoryId: uuidv4()
    };
  }
}

/**
 * Función para actualizar la memoria con un segmento usado
 */
export async function updateLeadGenMemoryWithSegment(
  agentId: string, 
  userId: string,
  segmentId: string,
  region?: string
): Promise<void> {
  try {
    console.log(`🧠 Actualizando memoria con segmento usado: ${segmentId}`);
    
    // Obtener memoria actual
    const { data: existingMemory, error: memoryError } = await supabaseAdmin
      .from('agent_memories')
      .select('*')
      .eq('agent_id', agentId)
      .eq('type', 'lead_generation')
      .eq('key', 'lead_generation')
      .order('created_at', { ascending: false })
      .limit(1)
      .single();
    
    if (memoryError) {
      console.error('Error al obtener memoria para actualizar:', memoryError);
      return;
    }
    
    if (!existingMemory) {
      console.error('No se encontró memoria existente para actualizar');
      return;
    }
    
    const memoryData = existingMemory.data || {};
    const usedSegments = memoryData.usedSegments || [];
    const usedSegmentsByRegion = memoryData.usedSegmentsByRegion || {};
    
    // Agregar segmento si no está ya usado globalmente
    if (!usedSegments.includes(segmentId)) {
      usedSegments.push(segmentId);
      console.log(`✅ Segmento ${segmentId} agregado a memoria global`);
    } else {
      console.log(`⚠️ Segmento ${segmentId} ya estaba en memoria global`);
    }
    
    // Agregar segmento por región si se especifica región
    if (region) {
      if (!usedSegmentsByRegion[region]) {
        usedSegmentsByRegion[region] = [];
      }
      
      if (!usedSegmentsByRegion[region].includes(segmentId)) {
        usedSegmentsByRegion[region].push(segmentId);
        console.log(`✅ Segmento ${segmentId} agregado a memoria para región ${region}`);
      } else {
        console.log(`⚠️ Segmento ${segmentId} ya estaba en memoria para región ${region}`);
      }
    }
    
    // Actualizar memoria con nuevo segmento
    const updatedMemoryData = {
      ...memoryData,
      usedSegments: usedSegments,
      usedSegmentsByRegion: usedSegmentsByRegion,
      lastUpdated: new Date().toISOString()
    };
    
    const { error: updateError } = await supabaseAdmin
      .from('agent_memories')
      .update({
        data: updatedMemoryData,
        updated_at: new Date().toISOString(),
        access_count: (existingMemory.access_count || 0) + 1,
        last_accessed: new Date().toISOString()
      })
      .eq('id', existingMemory.id);
    
    if (updateError) {
      console.error('Error al actualizar memoria con segmento:', updateError);
    } else {
      console.log(`📝 Memoria actualizada con segmento: ${segmentId}`);
    }
    
  } catch (error) {
    console.error('Error en updateLeadGenMemoryWithSegment:', error);
  }
}

/**
 * Función para actualizar la memoria con ciudades y regiones determinadas por el agente
 */
export async function updateLeadGenMemoryWithLocation(
  agentId: string, 
  userId: string,
  determinedCity: string | null,
  determinedRegion: string | null
): Promise<void> {
  try {
    console.log(`🧠 Actualizando memoria con ubicación determinada por agente: ${determinedCity}, ${determinedRegion}`);
    
    // Obtener memoria actual
    const { data: existingMemory, error: memoryError } = await supabaseAdmin
      .from('agent_memories')
      .select('*')
      .eq('agent_id', agentId)
      .eq('type', 'lead_generation')
      .eq('key', 'lead_generation')
      .order('created_at', { ascending: false })
      .limit(1)
      .single();
    
    if (memoryError) {
      console.error('Error al obtener memoria para actualizar ubicación:', memoryError);
      return;
    }
    
    if (!existingMemory) {
      console.error('No se encontró memoria existente para actualizar ubicación');
      return;
    }
    
    const memoryData = existingMemory.data || {};
    let usedCities = memoryData.usedCities || [];
    let usedRegions = memoryData.usedRegions || {};
    
    // Agregar ciudad si fue determinada y no está ya en la lista
    if (determinedCity && !usedCities.includes(determinedCity)) {
      usedCities.push(determinedCity);
      console.log(`✅ Ciudad ${determinedCity} agregada a memoria`);
    }
    
    // Agregar región si fue determinada
    if (determinedCity && determinedRegion) {
      if (!usedRegions[determinedCity]) {
        usedRegions[determinedCity] = [];
      }
      
      if (!usedRegions[determinedCity].includes(determinedRegion)) {
        usedRegions[determinedCity].push(determinedRegion);
        console.log(`✅ Región ${determinedRegion} agregada a memoria para ciudad ${determinedCity}`);
      }
    }
    
    // Actualizar memoria con nueva ubicación
    const updatedMemoryData = {
      ...memoryData,
      usedCities: usedCities,
      usedRegions: usedRegions,
      lastUpdated: new Date().toISOString(),
      lastDeterminedCity: determinedCity,
      lastDeterminedRegion: determinedRegion
    };
    
    const { error: updateError } = await supabaseAdmin
      .from('agent_memories')
      .update({
        data: updatedMemoryData,
        updated_at: new Date().toISOString(),
        access_count: (existingMemory.access_count || 0) + 1,
        last_accessed: new Date().toISOString()
      })
      .eq('id', existingMemory.id);
    
    if (updateError) {
      console.error('Error al actualizar memoria con ubicación:', updateError);
    } else {
      console.log(`📝 Memoria actualizada con ubicación determinada por agente`);
    }
    
  } catch (error) {
    console.error('Error en updateLeadGenMemoryWithLocation:', error);
  }
}

/**
 * Función para encontrar un agente de ventas activo para un sitio
 */
export async function findActiveSalesAgent(siteId: string): Promise<{agentId: string, userId: string} | null> {
  try {
    if (!siteId || !isValidUUID(siteId)) {
      console.error(`❌ Invalid site_id for agent search: ${siteId}`);
      return null;
    }
    
    console.log(`🔍 Buscando agente de ventas activo para el sitio: ${siteId}`);
    
    // Buscar por diferentes roles de ventas
    const salesRoles = ['Sales/CRM Specialist', 'Sales', 'sales'];
    
    for (const role of salesRoles) {
      const { data, error } = await supabaseAdmin
        .from('agents')
        .select('id, user_id')
        .eq('site_id', siteId)
        .eq('role', role)
        .eq('status', 'active')
        .order('created_at', { ascending: false })
        .limit(1);
      
      if (!error && data && data.length > 0) {
        console.log(`✅ Agente de ventas encontrado con role "${role}": ${data[0].id} (user_id: ${data[0].user_id})`);
        return {
          agentId: data[0].id,
          userId: data[0].user_id
        };
      }
    }
    
    console.log(`⚠️ No se encontró ningún agente de ventas activo para el sitio: ${siteId}`);
    return null;
  } catch (error) {
    console.error('Error al buscar agente de ventas:', error);
    return null;
  }
}

/**
 * Función para obtener la información del agente desde la base de datos
 */
export async function getAgentInfo(agentId: string): Promise<{ user_id: string; site_id?: string; tools?: any[]; activities?: any[] } | null> {
  try {
    if (!isValidUUID(agentId)) {
      console.error(`ID de agente no válido: ${agentId}`);
      return null;
    }
    
    console.log(`🔍 Obteniendo información del agente: ${agentId}`);
    
    const { data, error } = await supabaseAdmin
      .from('agents')
      .select('id, user_id, site_id, configuration')
      .eq('id', agentId)
      .single();
    
    if (error) {
      console.error('Error al obtener información del agente:', error);
      return null;
    }
    
    if (!data) {
      console.log(`⚠️ No se encontró el agente con ID: ${agentId}`);
      return null;
    }
    
    let config = data.configuration;
    if (typeof config === 'string') {
      try {
        config = JSON.parse(config);
      } catch (e) {
        console.error('Error parsing agent configuration:', e);
        config = {};
      }
    }
    
    config = config || {};
    
    return {
      user_id: data.user_id,
      site_id: data.site_id,
      tools: config.tools || [],
      activities: config.activities || []
    };
  } catch (error) {
    console.error('Error al obtener información del agente:', error);
    return null;
  }
}

/**
 * Función para obtener insights de negocios de una región
 */
export async function getRegionBusinessInsights(region: string): Promise<{
  popularIndustries: string[],
  growingBusinessTypes: string[],
  marketTrends: string[],
  economicData: {
    population?: number,
    avgIncome?: number,
    businessDensity?: number
  },
  competitorAnalysis: {
    dominantTypes: string[],
    gaps: string[]
  }
}> {
  try {
    console.log(`🔍 Obteniendo insights de negocios para región: ${region}`);
    
    // En una implementación real, esto podría conectarse a APIs externas
    // o bases de datos de mercado. Por ahora, simulamos insights básicos.
    
    // Mapeo básico de regiones españolas con sus industrias típicas
    const regionInsights: { [key: string]: any } = {
      'Madrid': {
        popularIndustries: ['Technology', 'Finance', 'Consulting', 'Marketing', 'Real Estate'],
        growingBusinessTypes: ['FinTech', 'PropTech', 'E-commerce', 'Digital Marketing', 'Coworking'],
        marketTrends: ['Digital transformation', 'Remote work solutions', 'Sustainability'],
        economicData: { population: 6700000, avgIncome: 35000, businessDensity: 8.5 },
        competitorAnalysis: {
          dominantTypes: ['Corporate services', 'Tech startups', 'Financial services'],
          gaps: ['Niche consulting', 'Specialized services', 'Local artisans']
        }
      },
      'Barcelona': {
        popularIndustries: ['Tourism', 'Technology', 'Design', 'Manufacturing', 'Food & Beverage'],
        growingBusinessTypes: ['Food tech', 'Design studios', 'Sustainable tourism', 'Gaming', 'Fashion'],
        marketTrends: ['Smart city initiatives', 'Sustainable tourism', 'Creative industries'],
        economicData: { population: 5600000, avgIncome: 32000, businessDensity: 7.8 },
        competitorAnalysis: {
          dominantTypes: ['Tourism services', 'Creative agencies', 'Manufacturing'],
          gaps: ['B2B services', 'Specialized consulting', 'Local crafts']
        }
      },
      'Valencia': {
        popularIndustries: ['Agriculture', 'Port services', 'Manufacturing', 'Tourism', 'Ceramics'],
        growingBusinessTypes: ['AgriTech', 'Logistics', 'Food processing', 'Renewable energy'],
        marketTrends: ['Port expansion', 'Agricultural innovation', 'Green energy'],
        economicData: { population: 2500000, avgIncome: 28000, businessDensity: 6.2 },
        competitorAnalysis: {
          dominantTypes: ['Port services', 'Agricultural services', 'Manufacturing'],
          gaps: ['Tech services', 'Creative industries', 'Professional services']
        }
      },
      'Sevilla': {
        popularIndustries: ['Tourism', 'Agriculture', 'Aerospace', 'Education', 'Construction'],
        growingBusinessTypes: ['Cultural tourism', 'Olive oil industry', 'Educational services'],
        marketTrends: ['Heritage tourism', 'Agricultural exports', 'University services'],
        economicData: { population: 1950000, avgIncome: 26000, businessDensity: 5.8 },
        competitorAnalysis: {
          dominantTypes: ['Tourism operators', 'Agricultural exporters', 'Construction'],
          gaps: ['Digital services', 'Innovation consulting', 'Modern retail']
        }
      }
    };
    
    // Buscar insights específicos de la región
    const regionKey = Object.keys(regionInsights).find(key => 
      region.toLowerCase().includes(key.toLowerCase()) || 
      key.toLowerCase().includes(region.toLowerCase())
    );
    
    if (regionKey) {
      const insights = regionInsights[regionKey];
      console.log(`✅ Insights encontrados para ${regionKey}: ${insights.popularIndustries.length} industrias populares`);
      return insights;
    }
    
    // Si no hay insights específicos, retornar datos generales
    console.log(`📊 Usando insights generales para región: ${region}`);
    return {
      popularIndustries: ['Local services', 'Small business', 'Retail', 'Restaurants', 'Professional services'],
      growingBusinessTypes: ['Digital services', 'E-commerce', 'Local food', 'Wellness', 'Home services'],
      marketTrends: ['Digital adoption', 'Local consumption', 'Service economy'],
      economicData: { population: 500000, avgIncome: 25000, businessDensity: 5.0 },
      competitorAnalysis: {
        dominantTypes: ['Local services', 'Small retail', 'Traditional businesses'],
        gaps: ['Digital services', 'Modern retail', 'Professional services']
      }
    };
    
  } catch (error) {
    console.error('Error al obtener insights de la región:', error);
    return {
      popularIndustries: ['Local services', 'Small business'],
      growingBusinessTypes: ['Digital services', 'E-commerce'],
      marketTrends: ['Digital adoption'],
      economicData: {},
      competitorAnalysis: {
        dominantTypes: ['Local services'],
        gaps: ['Digital services']
      }
    };
  }
}

/**
 * Función para obtener información de billing y límites del plan
 */
export async function getBillingPlanInfo(siteId: string): Promise<{
  plan: string;
  dailyLeadLimit: number;
  creditsAvailable: number;
  creditsUsed: number;
}> {
  try {
    console.log(`💳 Obteniendo información de billing para sitio: ${siteId}`);
    
    const { data: billingData, error: billingError } = await supabaseAdmin
      .from('billing')
      .select('plan, credits_available, credits_used')
      .eq('site_id', siteId)
      .order('created_at', { ascending: false })
      .limit(1)
      .single();
    
    if (billingError) {
      console.error('Error al obtener datos de billing:', billingError);
      // Return default free plan if no billing data found
      return {
        plan: 'free',
        dailyLeadLimit: 8,
        creditsAvailable: 0,
        creditsUsed: 0
      };
    }
    
    const plan = billingData?.plan || 'free';
    let dailyLeadLimit = 8; // default free plan
    
    // Set daily limits based on plan
    switch (plan.toLowerCase()) {
      case 'startup':
        dailyLeadLimit = 40;
        break;
      case 'enterprise':
        dailyLeadLimit = 100;
        break;
      case 'free':
      default:
        dailyLeadLimit = 8;
        break;
    }
    
    console.log(`✅ Plan encontrado: ${plan}, límite diario: ${dailyLeadLimit} leads`);
    
    return {
      plan,
      dailyLeadLimit,
      creditsAvailable: billingData?.credits_available || 0,
      creditsUsed: billingData?.credits_used || 0
    };
  } catch (error) {
    console.error('Error al obtener información de billing:', error);
    return {
      plan: 'free',
      dailyLeadLimit: 8,
      creditsAvailable: 0,
      creditsUsed: 0
    };
  }
}

/**
 * Función para obtener contexto básico de leads recientes por ubicación
 */
export async function getRecentLeadsContext(siteId: string): Promise<{
  totalLeadsLastWeek: number;
  hasRecentActivity: boolean;
  activeCities: string[];
  contextMessage: string;
}> {
  try {
    console.log(`📊 Obteniendo contexto de leads recientes para sitio: ${siteId}`);
    
    // Calculate date for one week ago
    const oneWeekAgo = new Date();
    oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);
    const timeFilter = oneWeekAgo.toISOString();
    
    const { data: leadsData, error: leadsError } = await supabaseAdmin
      .from('leads')
      .select('address, company, created_at')
      .eq('site_id', siteId)
      .gte('created_at', timeFilter)
      .order('created_at', { ascending: false });
    
    if (leadsError) {
      console.error('Error al obtener leads para contexto:', leadsError);
      return {
        totalLeadsLastWeek: 0,
        hasRecentActivity: false,
        activeCities: [],
        contextMessage: 'No recent lead activity data available'
      };
    }
    
    const citiesWithActivity = new Set<string>();
    let totalLeadsLastWeek = 0;
    
    if (leadsData && leadsData.length > 0) {
      leadsData.forEach(lead => {
        totalLeadsLastWeek++;
        
        let city = '';
        
        // Try to extract city from address field first
        if (lead.address && typeof lead.address === 'object' && lead.address.city) {
          city = lead.address.city.trim();
        } 
        // Try to extract city from company field if address doesn't have it
        else if (lead.company && typeof lead.company === 'object' && lead.company.location) {
          city = lead.company.location.trim();
        }
        // Try to extract from company.city if available
        else if (lead.company && typeof lead.company === 'object' && lead.company.city) {
          city = lead.company.city.trim();
        }
        
        // Add to set if we found a valid city
        if (city && city.length > 0) {
          citiesWithActivity.add(city);
        }
      });
    }
    
    const activeCities = Array.from(citiesWithActivity);
    const hasRecentActivity = totalLeadsLastWeek > 0;
    
    // Generate simple context message
    let contextMessage = '';
    if (hasRecentActivity) {
      if (activeCities.length > 0) {
        contextMessage = `Recent leads found in: ${activeCities.slice(0, 5).join(', ')}${activeCities.length > 5 ? ' and others' : ''}`;
      } else {
        contextMessage = `${totalLeadsLastWeek} leads generated recently but location data incomplete`;
      }
    } else {
      contextMessage = 'No leads generated in the past week';
    }
    
    console.log(`✅ Contexto obtenido: ${totalLeadsLastWeek} leads, ${activeCities.length} ciudades activas`);
    
    return {
      totalLeadsLastWeek,
      hasRecentActivity,
      activeCities,
      contextMessage
    };
  } catch (error) {
    console.error('Error al obtener contexto de leads recientes:', error);
    return {
      totalLeadsLastWeek: 0,
      hasRecentActivity: false,
      activeCities: [],
      contextMessage: 'Unable to retrieve recent lead activity'
    };
  }
}

/**
 * Función para obtener rendimiento de leads en regiones recientes
 */
export async function getRecentRegionPerformance(agentId: string, userId: string): Promise<{
  recentRegions: Array<{ region: string; city: string; leadsCount: number; searchDate: string }>;
  averageLeadsPerRegion: number;
  lowPerformingRegions: string[];
  recommendChangeStrategy: boolean;
}> {
  try {
    console.log(`📈 Analizando rendimiento de regiones recientes para agente: ${agentId}`);
    
    // Get memory for recent regions searched
    const { usedCities, usedRegions } = await getOrCreateLeadGenMemory(agentId, userId);
    
    // Calculate recent performance (last 7 days)
    const oneWeekAgo = new Date();
    oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);
    
    const recentRegions: Array<{ region: string; city: string; leadsCount: number; searchDate: string }> = [];
    let totalLeads = 0;
    let regionsCount = 0;
    
    // Analyze recent searches for each used city/region
    for (const [city, regions] of Object.entries(usedRegions)) {
      for (const region of regions) {
        // This is a simplified analysis - in a real implementation you'd track
        // actual lead generation results per region/city combination
        // For now, we'll simulate based on recent activity
        
        const mockLeadsCount = Math.floor(Math.random() * 15); // 0-14 leads
        recentRegions.push({
          region,
          city,
          leadsCount: mockLeadsCount,
          searchDate: new Date(Date.now() - Math.random() * 7 * 24 * 60 * 60 * 1000).toISOString()
        });
        
        totalLeads += mockLeadsCount;
        regionsCount++;
      }
    }
    
    // Sort by search date (most recent first)
    recentRegions.sort((a, b) => new Date(b.searchDate).getTime() - new Date(a.searchDate).getTime());
    
    const averageLeadsPerRegion = regionsCount > 0 ? totalLeads / regionsCount : 0;
    
    // Identify low-performing regions (less than 50% of average)
    const threshold = averageLeadsPerRegion * 0.5;
    const lowPerformingRegions = recentRegions
      .filter(r => r.leadsCount < threshold)
      .map(r => `${r.city} - ${r.region}`);
    
    // Recommend strategy change if more than 60% of recent regions are low-performing
    const recommendChangeStrategy = lowPerformingRegions.length > (recentRegions.length * 0.6);
    
    console.log(`✅ Análisis completado: ${recentRegions.length} regiones, promedio ${averageLeadsPerRegion.toFixed(1)} leads`);
    
    return {
      recentRegions: recentRegions.slice(0, 5), // Last 5 regions
      averageLeadsPerRegion,
      lowPerformingRegions,
      recommendChangeStrategy
    };
  } catch (error) {
    console.error('Error al analizar rendimiento de regiones:', error);
    return {
      recentRegions: [],
      averageLeadsPerRegion: 0,
      lowPerformingRegions: [],
      recommendChangeStrategy: false
    };
  }
}

 