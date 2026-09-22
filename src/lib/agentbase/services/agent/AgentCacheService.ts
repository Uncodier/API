/**
 * AgentCacheService - Servicio para gestionar el caché de agentes
 */
import { DatabaseAdapter } from '../../adapters/DatabaseAdapter';
import {
  deleteRedisKeys,
  readRedisJson,
} from '@/lib/services/redis-json-cache';
import { getRedisClient } from '@/lib/utils/redis-client';

const instances = new Set<AgentCacheService>();

function agentCacheKey(agentId: string): string {
  return `cache:agent-data:${agentId}`;
}

function siteAgentsKey(siteId: string): string {
  return `cache:site-agents:${siteId}`;
}

export class AgentCacheService {
  private agentCache: Record<string, {data: any, timestamp: number}> = {};
  // Tiempo de vida del caché en milisegundos (10 minutos)
  private readonly CACHE_TTL = 10 * 60 * 1000;
  
  constructor() {
    instances.add(this);
    console.log('📦 [EDGE] AgentCacheService: Inicializado');
    
    // Note: In Edge Functions, setInterval might not work as expected
    // Cache cleanup will happen on-demand instead
  }
  
  /**
   * Obtiene datos del agente desde el caché
   * @returns Un objeto con los datos del agente y un indicador de si fue obtenido del caché
   */
  public async getAgentData(agentId: string): Promise<{ agentData: any, fromCache: boolean } | null> {
    if (!DatabaseAdapter.isValidUUID(agentId)) {
      return null;
    }
    
    const now = Date.now();
    const cacheEntry = this.agentCache[agentId];
    
    // Verificar si existe en el caché y no ha expirado
    if (cacheEntry && (now - cacheEntry.timestamp) < this.CACHE_TTL) {
      console.log(`✅ Usando información del agente desde caché: ${agentId}`);
      return { agentData: cacheEntry.data, fromCache: true };
    }
    
    // Si ha expirado, eliminarlo
    if (cacheEntry) {
      console.log(`⏰ Caché expirado para agente ${agentId}`);
      delete this.agentCache[agentId];
    }

    const shared = await readRedisJson<any>(agentCacheKey(agentId));
    if (shared) {
      this.agentCache[agentId] = { data: shared, timestamp: now };
      return { agentData: shared, fromCache: true };
    }
    
    return null;
  }
  
  /**
   * Almacena datos del agente en el caché
   */
  public async setAgentData(agentId: string, data: any): Promise<void> {
    if (!DatabaseAdapter.isValidUUID(agentId) || !data) {
      return;
    }
    
    this.agentCache[agentId] = { 
      data, 
      timestamp: Date.now() 
    };
    await this.writeSharedEntry(agentId, data);
    
    console.log(`📥 Datos del agente ${agentId} guardados en caché`);
  }
  
  /**
   * Invalida el caché para un agente específico
   */
  public invalidateCache(agentId: string): void {
    if (this.agentCache[agentId]) {
      delete this.agentCache[agentId];
      console.log(`🧹 Caché invalidado para agente: ${agentId}`);
    }
    void deleteRedisKeys(agentCacheKey(agentId));
  }

  private async writeSharedEntry(
    agentId: string,
    data: any,
  ): Promise<void> {
    if (!process.env.REDIS_CACHE_URL?.trim() && !process.env.REDIS_URL?.trim()) {
      return;
    }
    try {
      const redis = getRedisClient();
      const ttl = this.CACHE_TTL / 1_000;
      const transaction = redis
        .multi()
        .set(agentCacheKey(agentId), JSON.stringify(data), 'EX', ttl);
      if (typeof data.site_id === 'string') {
        transaction
          .sadd(siteAgentsKey(data.site_id), agentId)
          .expire(siteAgentsKey(data.site_id), ttl);
      }
      await transaction.exec();
    } catch {
      // Shared cache is optional; local caching remains available.
    }
  }

  public invalidateSite(siteId: string): void {
    for (const [agentId, entry] of Object.entries(this.agentCache)) {
      if (entry.data?.site_id === siteId) delete this.agentCache[agentId];
    }
  }
  
  /**
   * Limpia todas las entradas expiradas del caché
   */
  public cleanExpiredCache(): void {
    const now = Date.now();
    let expiredCount = 0;
    
    // Revisar y eliminar entradas expiradas
    for (const agentId in this.agentCache) {
      const cacheEntry = this.agentCache[agentId];
      if ((now - cacheEntry.timestamp) >= this.CACHE_TTL) {
        delete this.agentCache[agentId];
        expiredCount++;
      }
    }
    
    if (expiredCount > 0) {
      console.log(`🧹 Limpieza de caché: ${expiredCount} entradas expiradas eliminadas`);
    }
  }
  
  /**
   * Obtiene el tamaño actual del caché
   */
  public getCacheSize(): number {
    return Object.keys(this.agentCache).length;
  }
}

export async function invalidateAgentCachesForSite(
  siteId: string,
): Promise<void> {
  instances.forEach((instance) => instance.invalidateSite(siteId));
  if (!process.env.REDIS_CACHE_URL?.trim() && !process.env.REDIS_URL?.trim()) {
    return;
  }
  try {
    const redis = getRedisClient();
    const agentIds = await redis.smembers(siteAgentsKey(siteId));
    await deleteRedisKeys(
      siteAgentsKey(siteId),
      ...agentIds.map(agentCacheKey),
    );
  } catch {
    // Cache invalidation must not make settings writes fail.
  }
}