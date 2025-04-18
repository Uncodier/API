/**
 * MemoryStore for agent memory management
 */

export class MemoryStore {
  private agentId: string;
  private memoryCache: Map<string, any> = new Map();
  
  constructor(agentId: string) {
    this.agentId = agentId;
  }
  
  /**
   * Store a memory item
   */
  async store(params: {
    userId: string;
    type: string;
    key: string;
    data: any;
    rawData?: string;
    metadata?: any;
  }): Promise<string> {
    const memoryId = `mem_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    
    const memory = {
      id: memoryId,
      agent_id: this.agentId,
      user_id: params.userId,
      type: params.type,
      key: params.key,
      data: params.data,
      raw_data: params.rawData,
      metadata: params.metadata,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      access_count: 0
    };
    
    // Store in local cache
    this.memoryCache.set(params.key, memory);
    
    // TODO: Implement database storage when available
    // For now, we just use in-memory storage
    
    return memoryId;
  }
  
  /**
   * Retrieve a memory item by key
   */
  async retrieve(key: string): Promise<any> {
    const memory = this.memoryCache.get(key);
    
    if (memory) {
      // Update access count
      memory.access_count += 1;
      memory.updated_at = new Date().toISOString();
      this.memoryCache.set(key, memory);
      
      return memory.data;
    }
    
    // TODO: Implement database retrieval when available
    
    return null;
  }
  
  /**
   * Retrieve memories by type
   */
  async retrieveByType(type: string, limit: number = 10): Promise<any[]> {
    const memories: any[] = [];
    
    // Retrieve from cache
    Array.from(this.memoryCache.values()).forEach(memory => {
      if (memory.type === type) {
        memories.push(memory.data);
      }
    });
    
    // Limit the number of results
    return memories.slice(0, limit);
  }
  
  /**
   * Update a memory item
   */
  async update(key: string, data: any, rawData?: string): Promise<boolean> {
    const memory = this.memoryCache.get(key);
    
    if (memory) {
      memory.data = data;
      memory.raw_data = rawData;
      memory.updated_at = new Date().toISOString();
      memory.access_count += 1;
      
      this.memoryCache.set(key, memory);
      
      // TODO: Implement database update when available
      
      return true;
    }
    
    return false;
  }
  
  /**
   * Get the latest entries of a specific type
   */
  getLatestEntries(limit: number = 10, type?: string): any[] {
    const entries = Array.from(this.memoryCache.values())
      // Filter by type if specified
      .filter(memory => !type || memory.type === type)
      // Sort by creation date in descending order (newest first)
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
      // Limit the result set
      .slice(0, limit);
    
    return entries;
  }
  
  /**
   * Get the most recent entry of a specific type
   */
  getLatestEntry(type?: string): any | null {
    const entries = this.getLatestEntries(1, type);
    return entries.length > 0 ? entries[0] : null;
  }
  
  /**
   * Clear all memories for this agent
   */
  async clear(): Promise<boolean> {
    this.memoryCache.clear();
    
    // TODO: Implement database clearing when available
    
    return true;
  }
} 