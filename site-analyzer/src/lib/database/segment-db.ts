import { supabaseAdmin } from './supabase-client'

/**
 * Interfaz para los segmentos en la base de datos
 */
interface DbSegment {
  id: string;
  name: string;
  description: string | null;
  audience: string | null;
  size: number | null;
  estimated_value: number | null;
  engagement: number | null;
  is_active: boolean | null;
  analysis: any[] | null;
  topics: any[] | null;
  site_id: string;
  user_id: string;
  created_at?: string;
  updated_at?: string;
  language: string;
  url: string | null;
}

/**
 * Interfaz para crear un nuevo segmento
 */
interface CreateSegmentParams {
  id?: string;
  name: string;
  description: string;
  audience: string;
  size: number;
  estimated_value?: number;
  is_active: boolean;
  analysis: any[];
  topics: any[];
  site_id: string;
  user_id: string;
  language: string;
  url: string;
}

/**
 * Crea un nuevo segmento en la base de datos
 * 
 * @param segmentData Datos del segmento a crear
 * @returns El segmento creado o null si hubo un error
 */
export async function createSegmentInDatabase(segmentData: CreateSegmentParams): Promise<DbSegment | null> {
  try {
    const { data, error } = await supabaseAdmin
      .from('segments')
      .insert([{
        name: segmentData.name,
        description: segmentData.description,
        audience: segmentData.audience,
        size: segmentData.size,
        estimated_value: segmentData.estimated_value || 0,
        engagement: 0, // Valor inicial
        is_active: segmentData.is_active,
        analysis: segmentData.analysis || [],
        topics: segmentData.topics || [],
        site_id: segmentData.site_id,
        user_id: segmentData.user_id,
        language: segmentData.language,
        url: segmentData.url
      }])
      .select()
      .single();
    
    if (error) {
      console.error('Error al crear segmento:', error);
      throw new Error(`Error al crear segmento: ${error.message}`);
    }
    
    return data;
  } catch (error: any) {
    console.error('Error en createSegmentInDatabase:', error);
    throw new Error(`Error al crear segmento en la base de datos: ${error.message}`);
  }
}

/**
 * Actualiza un segmento existente
 * 
 * @param segmentId ID del segmento a actualizar
 * @param updates Campos a actualizar
 * @returns true si se actualizó correctamente
 */
export async function updateSegment(
  segmentId: string, 
  updates: Partial<Omit<DbSegment, 'id' | 'created_at' | 'updated_at'>>
): Promise<boolean> {
  try {
    const { error } = await supabaseAdmin
      .from('segments')
      .update({
        ...updates,
        updated_at: new Date().toISOString()
      })
      .eq('id', segmentId);
    
    if (error) {
      console.error('Error al actualizar segmento:', error);
      throw new Error(`Error al actualizar segmento: ${error.message}`);
    }
    
    return true;
  } catch (error: any) {
    console.error('Error en updateSegment:', error);
    throw new Error(`Error al actualizar segmento: ${error.message}`);
  }
}

/**
 * Busca segmentos similares para evitar duplicados
 * 
 * @param userId ID del usuario propietario
 * @param segmentName Nombre del segmento a buscar
 * @param siteUrl URL del sitio asociado
 * @returns Array de segmentos similares encontrados
 */
export async function findSimilarSegments(
  userId: string, 
  segmentName: string,
  siteUrl: string
): Promise<DbSegment[]> {
  try {
    // Buscar por coincidencia exacta de nombre y sitio
    const { data: exactMatch, error: exactError } = await supabaseAdmin
      .from('segments')
      .select('*')
      .eq('user_id', userId)
      .eq('name', segmentName)
      .eq('url', siteUrl);
    
    if (exactError) {
      console.error('Error al buscar segmentos similares:', exactError);
      throw new Error(`Error al buscar segmentos similares: ${exactError.message}`);
    }
    
    if (exactMatch && exactMatch.length > 0) {
      return exactMatch;
    }
    
    // Si no hay coincidencia exacta, buscar por similitud en el nombre
    const { data: similarMatch, error: similarError } = await supabaseAdmin
      .from('segments')
      .select('*')
      .eq('user_id', userId)
      .eq('url', siteUrl)
      .ilike('name', `%${segmentName}%`)
      .limit(5);
    
    if (similarError) {
      console.error('Error al buscar segmentos similares:', similarError);
      throw new Error(`Error al buscar segmentos similares: ${similarError.message}`);
    }
    
    return similarMatch || [];
  } catch (error: any) {
    console.error('Error en findSimilarSegments:', error);
    throw new Error(`Error al buscar segmentos similares: ${error.message}`);
  }
}

/**
 * Obtiene todos los segmentos de un sitio específico
 * 
 * @param siteId ID del sitio
 * @param userId ID del usuario propietario
 * @returns Array de segmentos del sitio
 */
export async function getSegmentsBySite(siteId: string, userId: string): Promise<DbSegment[]> {
  try {
    const { data, error } = await supabaseAdmin
      .from('segments')
      .select('*')
      .eq('site_id', siteId)
      .eq('user_id', userId)
      .order('created_at', { ascending: false });
    
    if (error) {
      console.error('Error al obtener segmentos del sitio:', error);
      throw new Error(`Error al obtener segmentos del sitio: ${error.message}`);
    }
    
    return data || [];
  } catch (error: any) {
    console.error('Error en getSegmentsBySite:', error);
    throw new Error(`Error al obtener segmentos del sitio: ${error.message}`);
  }
}

/**
 * Marca un segmento como activo o inactivo
 * 
 * @param segmentId ID del segmento
 * @param isActive Estado de activación
 * @param userId ID del usuario propietario
 * @returns true si se actualizó correctamente
 */
export async function setSegmentActive(
  segmentId: string, 
  isActive: boolean, 
  userId: string
): Promise<boolean> {
  try {
    const { error } = await supabaseAdmin
      .from('segments')
      .update({
        is_active: isActive,
        updated_at: new Date().toISOString()
      })
      .eq('id', segmentId)
      .eq('user_id', userId);
    
    if (error) {
      console.error('Error al actualizar estado del segmento:', error);
      throw new Error(`Error al actualizar estado del segmento: ${error.message}`);
    }
    
    return true;
  } catch (error: any) {
    console.error('Error en setSegmentActive:', error);
    throw new Error(`Error al actualizar estado del segmento: ${error.message}`);
  }
} 