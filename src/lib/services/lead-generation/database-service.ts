/**
 * Funciones de base de datos para lead generation
 */

import { supabaseAdmin } from '@/lib/database/supabase-client';
import { v4 as uuidv4 } from 'uuid';
import { LeadData, SegmentData } from './search-prompt-generator';

// Lista de ciudades por defecto para rotar
export const DEFAULT_CITIES = [
  'Madrid', 'Barcelona', 'Valencia', 'Sevilla', 'Zaragoza', 'Málaga', 'Murcia', 'Palma', 'Las Palmas', 'Bilbao',
  'Alicante', 'Córdoba', 'Valladolid', 'Vigo', 'Gijón', 'L\'Hospitalet', 'A Coruña', 'Vitoria', 'Granada', 'Elche',
  'Oviedo', 'Badalona', 'Cartagena', 'Terrassa', 'Jerez', 'Sabadell', 'Móstoles', 'Santa Cruz de Tenerife', 'Pamplona', 'Almería'
];

/**
 * Función para validar UUIDs
 */
export function isValidUUID(uuid: string): boolean {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(uuid);
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
 */
export async function getOrCreateLeadGenMemory(agentId: string, userId: string): Promise<{
  currentCityIndex: number,
  targetCity: string,
  targetRegion: string | null,
  usedCities: string[],
  usedRegions: { [key: string]: string[] },
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
    
    let currentCityIndex = 0;
    let usedCities: string[] = [];
    let usedRegions: { [key: string]: string[] } = {};
    let memoryId: string;
    
    if (existingMemory) {
      console.log(`✅ Memoria existente encontrada: ${existingMemory.id}`);
      const memoryData = existingMemory.data || {};
      currentCityIndex = memoryData.currentCityIndex || 0;
      usedCities = memoryData.usedCities || [];
      usedRegions = memoryData.usedRegions || {};
      memoryId = existingMemory.id;
      
      // Incrementar índice para la siguiente ciudad
      currentCityIndex = (currentCityIndex + 1) % DEFAULT_CITIES.length;
    } else {
      console.log(`🆕 Creando nueva memoria de lead_generation`);
      memoryId = uuidv4();
      currentCityIndex = 0;
      usedCities = [];
      usedRegions = {};
    }
    
    const targetCity = DEFAULT_CITIES[currentCityIndex];
    const newUsedCities = [...usedCities];
    if (!newUsedCities.includes(targetCity)) {
      newUsedCities.push(targetCity);
    }
    
    // Inicializar regiones usadas para la ciudad si no existen
    if (!usedRegions[targetCity]) {
      usedRegions[targetCity] = [];
    }
    
    // Actualizar o crear memoria
    const memoryData = {
      id: memoryId,
      agent_id: agentId,
      user_id: userId,
      type: 'lead_generation',
      key: 'lead_generation',
      data: {
        currentCityIndex,
        targetCity,
        usedCities: newUsedCities,
        usedRegions: usedRegions,
        lastUpdated: new Date().toISOString(),
        totalCitiesAvailable: DEFAULT_CITIES.length
      },
      metadata: {
        purpose: 'track_city_and_region_targeting_progression',
        cityRotationStrategy: 'sequential',
        regionStrategy: 'dynamic_assignment'
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
        console.log(`📝 Memoria actualizada para siguiente ciudad: ${targetCity}`);
      }
    } else {
      // Crear nueva memoria
      const { error: insertError } = await supabaseAdmin
        .from('agent_memories')
        .insert([memoryData]);
      
      if (insertError) {
        console.error('Error al crear memoria:', insertError);
      } else {
        console.log(`📝 Nueva memoria creada para ciudad: ${targetCity}`);
      }
    }
    
    return {
      currentCityIndex,
      targetCity,
      targetRegion: null,
      usedCities: newUsedCities,
      usedRegions: usedRegions,
      memoryId
    };
    
  } catch (error) {
    console.error('Error en getOrCreateLeadGenMemory:', error);
    // Retornar valores por defecto en caso de error
    return {
      currentCityIndex: 0,
      targetCity: DEFAULT_CITIES[0],
      targetRegion: null,
      usedCities: [],
      usedRegions: {},
      memoryId: uuidv4()
    };
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

 