import { supabaseAdmin } from '@/lib/database/supabase-client';
import { v4 as uuidv4 } from 'uuid';

export interface SystemMemory {
  id: string;
  siteId: string;
  systemType: string;
  key: string;
  data: Record<string, any>;
  rawData?: string;
  metadata?: Record<string, any>;
  createdAt: string;
  updatedAt: string;
  accessCount: number;
  lastAccessed: string;
  expiresAt?: string;
  commandId?: string;
}

export interface SystemMemoryQueryParams {
  siteId: string;
  systemType: string;
  key: string;
}

export interface SystemMemoryCreateParams {
  siteId: string;
  systemType: string;
  key: string;
  data: Record<string, any>;
  rawData?: string;
  metadata?: Record<string, any>;
  expiresAt?: Date;
  commandId?: string;
}

export interface SystemMemoryResult {
  success: boolean;
  memory?: SystemMemory;
  error?: string;
}

export interface SystemMemoryListResult {
  success: boolean;
  memories?: SystemMemory[];
  error?: string;
}

export interface SystemMemoryCreateResult {
  success: boolean;
  memoryId?: string;
  error?: string;
}

/**
 * Servicio para manejar memorias del sistema que evitan operaciones repetitivas
 */
export class SystemMemoryService {
  /**
   * Busca una memoria específica del sistema
   */
  async findMemory(params: SystemMemoryQueryParams): Promise<SystemMemoryResult> {
    try {
      const { siteId, systemType, key } = params;
      
      const { data, error } = await supabaseAdmin
        .from('system_memories')
        .select('*')
        .eq('site_id', siteId)
        .eq('system_type', systemType)
        .eq('key', key)
        .maybeSingle();
      
      if (error) {
        console.error('Error finding system memory:', error);
        return {
          success: false,
          error: 'Failed to find system memory'
        };
      }
      
      if (!data) {
        return {
          success: true,
          memory: undefined
        };
      }
      
      // Incrementar contador de acceso
      await this.incrementAccessCount(data.id);
      
      return {
        success: true,
        memory: this.mapDatabaseToMemory(data)
      };
    } catch (error) {
      console.error('Error in findMemory:', error);
      return {
        success: false,
        error: 'Failed to find system memory'
      };
    }
  }
  
  /**
   * Crea una nueva memoria del sistema
   */
  async createMemory(params: SystemMemoryCreateParams): Promise<SystemMemoryCreateResult> {
    try {
      const id = uuidv4();
      const now = new Date().toISOString();
      
      const { error } = await supabaseAdmin
        .from('system_memories')
        .insert({
          id,
          site_id: params.siteId,
          system_type: params.systemType,
          key: params.key,
          data: params.data,
          raw_data: params.rawData,
          metadata: params.metadata || {},
          created_at: now,
          updated_at: now,
          access_count: 0,
          last_accessed: now,
          expires_at: params.expiresAt?.toISOString(),
          command_id: params.commandId
        });
      
      if (error) {
        console.error('Error creating system memory:', error);
        return {
          success: false,
          error: 'Failed to create system memory'
        };
      }
      
      return {
        success: true,
        memoryId: id
      };
    } catch (error) {
      console.error('Error in createMemory:', error);
      return {
        success: false,
        error: 'Failed to create system memory'
      };
    }
  }
  
  /**
   * Actualiza una memoria existente
   */
  async updateMemory(
    params: SystemMemoryQueryParams,
    updateData: Partial<SystemMemoryCreateParams>
  ): Promise<SystemMemoryCreateResult> {
    try {
      const { siteId, systemType, key } = params;
      const now = new Date().toISOString();
      
      const updatePayload: any = {
        updated_at: now,
        last_accessed: now
      };
      
      if (updateData.data) updatePayload.data = updateData.data;
      if (updateData.rawData) updatePayload.raw_data = updateData.rawData;
      if (updateData.metadata) updatePayload.metadata = updateData.metadata;
      if (updateData.expiresAt) updatePayload.expires_at = updateData.expiresAt.toISOString();
      
      const { error } = await supabaseAdmin
        .from('system_memories')
        .update(updatePayload)
        .eq('site_id', siteId)
        .eq('system_type', systemType)
        .eq('key', key);
      
      if (error) {
        console.error('Error updating system memory:', error);
        return {
          success: false,
          error: 'Failed to update system memory'
        };
      }
      
      return {
        success: true
      };
    } catch (error) {
      console.error('Error in updateMemory:', error);
      return {
        success: false,
        error: 'Failed to update system memory'
      };
    }
  }
  
  /**
   * Elimina memorias expiradas
   */
  async cleanupExpiredMemories(siteId: string): Promise<{ success: boolean; deletedCount?: number; error?: string }> {
    try {
      const { data, error } = await supabaseAdmin
        .from('system_memories')
        .delete()
        .eq('site_id', siteId)
        .lt('expires_at', new Date().toISOString())
        .select('id');
      
      if (error) {
        console.error('Error cleaning up expired memories:', error);
        return {
          success: false,
          error: 'Failed to cleanup expired memories'
        };
      }
      
      return {
        success: true,
        deletedCount: data?.length || 0
      };
    } catch (error) {
      console.error('Error in cleanupExpiredMemories:', error);
      return {
        success: false,
        error: 'Failed to cleanup expired memories'
      };
    }
  }
  
  /**
   * Lista memorias por tipo de sistema
   */
  async listMemories(siteId: string, systemType: string): Promise<SystemMemoryListResult> {
    try {
      const { data, error } = await supabaseAdmin
        .from('system_memories')
        .select('*')
        .eq('site_id', siteId)
        .eq('system_type', systemType)
        .order('created_at', { ascending: false });
      
      if (error) {
        console.error('Error listing system memories:', error);
        return {
          success: false,
          error: 'Failed to list system memories'
        };
      }
      
      return {
        success: true,
        memories: data?.map(d => this.mapDatabaseToMemory(d)) || []
      };
    } catch (error) {
      console.error('Error in listMemories:', error);
      return {
        success: false,
        error: 'Failed to list system memories'
      };
    }
  }
  
  /**
   * Incrementa el contador de acceso de una memoria
   */
  private async incrementAccessCount(memoryId: string): Promise<void> {
    try {
      // Primero obtenemos el conteo actual
      const { data: currentData } = await supabaseAdmin
        .from('system_memories')
        .select('access_count')
        .eq('id', memoryId)
        .single();
      
      // Incrementamos el contador
      const newCount = (currentData?.access_count || 0) + 1;
      
      await supabaseAdmin
        .from('system_memories')
        .update({
          access_count: newCount,
          last_accessed: new Date().toISOString()
        })
        .eq('id', memoryId);
    } catch (error) {
      console.error('Error incrementing access count:', error);
    }
  }
  
  /**
   * Mapea datos de la base de datos a la interfaz SystemMemory
   */
  private mapDatabaseToMemory(data: any): SystemMemory {
    return {
      id: data.id,
      siteId: data.site_id,
      systemType: data.system_type,
      key: data.key,
      data: data.data,
      rawData: data.raw_data,
      metadata: data.metadata,
      createdAt: data.created_at,
      updatedAt: data.updated_at,
      accessCount: data.access_count,
      lastAccessed: data.last_accessed,
      expiresAt: data.expires_at,
      commandId: data.command_id
    };
  }
}

// Instancia exportada para uso en otras partes de la aplicación
export const systemMemoryService = new SystemMemoryService(); 