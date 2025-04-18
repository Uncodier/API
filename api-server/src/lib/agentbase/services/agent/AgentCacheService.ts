/**
 * AgentCacheService - Servicio para gestionar el caché de agentes
 */
import { DatabaseAdapter } from '../../adapters/DatabaseAdapter';

export class AgentCacheService {
  private static instance: AgentCacheService;
  private agentCache: Record<string, {data: any, timestamp: number}> = {};
  // Tiempo de vida del caché en milisegundos (10 minutos)
  private readonly CACHE_TTL = 10 * 60 * 1000;
  
  private constructor() {
    console.log('📦 AgentCacheService: Inicializado');
    
    // Configurar limpieza periódica del caché (cada 5 minutos)
    setInterval(() => this.cleanExpiredCache(), 5 * 60 * 1000);
  }
  
  public static getInstance(): AgentCacheService {
    if (!AgentCacheService.instance) {
      AgentCacheService.instance = new AgentCacheService();
    }
    return AgentCacheService.instance;
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
    
    return null;
  }
  
  /**
   * Almacena datos del agente en el caché
   */
  public setAgentData(agentId: string, data: any): void {
    if (!DatabaseAdapter.isValidUUID(agentId) || !data) {
      return;
    }
    
    this.agentCache[agentId] = { 
      data, 
      timestamp: Date.now() 
    };
    
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