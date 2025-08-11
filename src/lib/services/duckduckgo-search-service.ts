import { fetchHtml } from '@/lib/utils/html-utils';
import { cleanHtmlContent } from '@/lib/utils/html-content-cleaner';
import { searchWithTavily } from '@/lib/services/search/data-analyst-search';

export interface DuckDuckGoSearchOptions {
  query: string;
  site?: string; // e.g., "news.ycombinator.com"
  dateFrom?: string; // YYYY-MM-DD format
  dateTo?: string; // YYYY-MM-DD format
  maxResults?: number;
  region?: string; // e.g., "us-en"
}

export interface SearchResult {
  title: string;
  url: string;
  domain: string;
  publishedDate?: string;
  // snippet removido para simplificar
}

export interface DuckDuckGoSearchResponse {
  success: boolean;
  results: SearchResult[];
  query: string;
  totalResults: number;
  error?: string;
}

export class DuckDuckGoSearchService {
  private static instance: DuckDuckGoSearchService;
  private baseUrl = 'https://html.duckduckgo.com/html';
  private instantApiUrl = 'https://api.duckduckgo.com/';

  static getInstance(): DuckDuckGoSearchService {
    if (!DuckDuckGoSearchService.instance) {
      DuckDuckGoSearchService.instance = new DuckDuckGoSearchService();
    }
    return DuckDuckGoSearchService.instance;
  }

  /**
   * Construye la query de búsqueda con filtros de fecha y sitio
   */
  private buildSearchQuery(options: DuckDuckGoSearchOptions): string {
    let query = options.query;

    // Agregar filtro de sitio si se especifica
    if (options.site) {
      query += ` site:${options.site}`;
    }

    // Agregar filtros de fecha si se especifican
    if (options.dateFrom) {
      query += ` after:${options.dateFrom}`;
    }

    if (options.dateTo) {
      query += ` before:${options.dateTo}`;
    }

    return query.trim();
  }

  /**
   * Construye la URL de búsqueda para DuckDuckGo usando un enfoque más liviano
   */
  private buildSearchUrl(options: DuckDuckGoSearchOptions): string {
    const searchQuery = this.buildSearchQuery(options);
    const encodedQuery = encodeURIComponent(searchQuery);
    
    // Usar endpoint más liviano sin JavaScript
    let url = `${this.baseUrl}?q=${encodedQuery}`;
    
    // Agregar región si se especifica
    if (options.region) {
      url += `&kl=${options.region}`;
    }

    // Parámetros para resultados sin JavaScript
    url += '&s=0'; // Comenzar desde el primer resultado
    url += '&dc=1'; // Habilitar clustering de dominios
    url += '&v=l'; // Versión lite sin JavaScript
    url += '&api=/d.js'; // Endpoint de datos estructurados

    return url;
  }

  /**
   * Extrae resultados de búsqueda del HTML de DuckDuckGo usando patrones mejorados
   */
  private parseSearchResults(html: string, maxResults: number = 20): SearchResult[] {
    const results: SearchResult[] = [];
    
    try {
      console.log(`🔍 [DuckDuckGo] Parseando HTML (${html.length} caracteres)`);
      
      // Patrones mejorados para la versión sin JavaScript de DuckDuckGo
      const resultBlocks = html.split('<div class="result">');
      
      for (let i = 1; i < Math.min(resultBlocks.length, maxResults + 1); i++) {
        const block = resultBlocks[i];
        
        // Extraer URL y título (simplificado, sin snippet)
        const urlMatch = block.match(/href="([^"]+)"/);
        const titleMatch = block.match(/<a[^>]*class="[^"]*result__a[^"]*"[^>]*>([^<]+)<\/a>/) ||
                          block.match(/<a[^>]*>([^<]+)<\/a>/);
        
        if (urlMatch && titleMatch) {
          const url = this.cleanUrl(urlMatch[1]);
          const title = this.cleanText(titleMatch[1]);
          
          if (url && title && this.isValidUrl(url)) {
            const domain = this.extractDomain(url);
            
            results.push({
              title,
              url,
              domain,
              publishedDate: undefined
            });
            
            console.log(`📄 [DuckDuckGo] URL ${results.length}: ${domain} - ${title.substring(0, 40)}...`);
          }
        }
      }

      // Si no encontramos resultados con el patrón principal, intentar patrones alternativos
      if (results.length === 0) {
        console.log(`🔄 [DuckDuckGo] Intentando patrones alternativos...`);
        this.parseWithAlternativePatterns(html, results, maxResults);
      }

    } catch (error) {
      console.error('❌ [DuckDuckGo] Error al parsear resultados:', error);
    }

    console.log(`✅ [DuckDuckGo] Parseados ${results.length} resultados`);
    return results;
  }

  /**
   * Intenta extraer resultados usando patrones alternativos
   */
  private parseWithAlternativePatterns(html: string, results: SearchResult[], maxResults: number): void {
    try {
      // Patrón alternativo para enlaces
      const linkPattern = /<a[^>]*href="([^"]+)"[^>]*>([^<]+)<\/a>/gi;
      let match;
      let count = 0;

      while ((match = linkPattern.exec(html)) !== null && count < maxResults) {
        const url = this.cleanUrl(match[1]);
        const title = this.cleanText(match[2]);
        
        if (url && title && this.isValidUrl(url) && title.length > 10) {
          const domain = this.extractDomain(url);
          
          // Evitar duplicados
          if (!results.some(r => r.url === url)) {
            results.push({
              title,
              url,
              domain,
              publishedDate: undefined
            });
            count++;
          }
        }
      }
    } catch (error) {
      console.error('❌ [DuckDuckGo] Error en patrones alternativos:', error);
    }
  }

  /**
   * Intenta extraer snippets para los resultados (método simplificado)
   */
  private addSnippetsToResults(html: string, results: SearchResult[]): void {
    // Este método ahora es menos necesario ya que extraemos snippets en parseSearchResults
    // Lo mantenemos para compatibilidad pero simplificado
    console.log(`🔍 [DuckDuckGo] Snippets ya extraídos en parseSearchResults`);
  }

  /**
   * Limpia y decodifica URLs
   */
  private cleanUrl(url: string): string {
    try {
      // DuckDuckGo redirige a través de sus propios enlaces
      if (url.includes('duckduckgo.com/l/?')) {
        const urlParams = new URLSearchParams(url.split('?')[1]);
        const actualUrl = urlParams.get('uddg');
        if (actualUrl) {
          return decodeURIComponent(actualUrl);
        }
      }
      
      return decodeURIComponent(url);
    } catch (error) {
      return url;
    }
  }

  /**
   * Limpia texto de HTML entities y espacios extra
   */
  private cleanText(text: string): string {
    return cleanHtmlContent(text).trim();
  }

  /**
   * Valida si una URL es válida
   */
  private isValidUrl(url: string): boolean {
    try {
      new URL(url);
      return url.startsWith('http') && !url.includes('duckduckgo.com');
    } catch {
      return false;
    }
  }

  /**
   * Extrae el dominio de una URL
   */
  private extractDomain(url: string): string {
    try {
      const urlObj = new URL(url);
      return urlObj.hostname;
    } catch {
      return '';
    }
  }

  /**
   * Calcula cuántos días han pasado desde una fecha
   */
  private calculateDaysAgo(dateString: string): number {
    try {
      const date = new Date(dateString);
      const now = new Date();
      const diffTime = now.getTime() - date.getTime();
      const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
      return Math.max(0, diffDays);
    } catch {
      return 30; // Default a 30 días si la fecha es inválida
    }
  }

  /**
   * Usa la API oficial de DuckDuckGo para respuestas instantáneas
   */
  private async searchWithInstantAPI(query: string): Promise<any> {
    try {
      console.log(`🦆 [DuckDuckGo] Probando API oficial para: "${query}"`);
      
      const url = `${this.instantApiUrl}?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
      
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; SearchBot/1.0)',
        },
        signal: AbortSignal.timeout(10000)
      });

      if (!response.ok) {
        throw new Error(`API Error: ${response.status}`);
      }

      const data = await response.json();
      
      // La API oficial solo proporciona respuestas instantáneas, no resultados de búsqueda web
      if (data.AbstractText || data.Answer || data.Infobox) {
        console.log(`✅ [DuckDuckGo] API oficial respondió con datos instantáneos`);
        return data;
      }
      
      console.log(`⚠️ [DuckDuckGo] API oficial sin resultados útiles para búsqueda web`);
      return null;
      
    } catch (error) {
      console.log(`❌ [DuckDuckGo] API oficial falló:`, error);
      return null;
    }
  }

  /**
   * Obtiene HTML usando fetch directo sin Puppeteer
   */
  private async fetchHtmlDirectly(url: string): Promise<string> {
    try {
      console.log(`🌐 [DuckDuckGo] Realizando fetch directo a: ${url}`);
      
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.5',
          'Accept-Encoding': 'gzip, deflate, br',
          'Connection': 'keep-alive',
          'Upgrade-Insecure-Requests': '1',
        },
        signal: AbortSignal.timeout(15000) // 15 segundos timeout
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const html = await response.text();
      console.log(`✅ [DuckDuckGo] HTML obtenido exitosamente (${html.length} caracteres)`);
      
      return html;
    } catch (error) {
      console.error('❌ [DuckDuckGo] Error en fetch directo:', error);
      throw error;
    }
  }

  /**
   * Fetch HTML con reintentos automáticos
   */
  private async fetchHtmlWithRetry(url: string, maxRetries: number = 2): Promise<string> {
    let lastError: Error | null = null;
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        console.log(`🔄 [DuckDuckGo] Intento ${attempt}/${maxRetries} para: ${url}`);
        
        // Pequeña pausa entre intentos
        if (attempt > 1) {
          await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
        }
        
        return await this.fetchHtmlDirectly(url);
        
      } catch (error) {
        lastError = error instanceof Error ? error : new Error('Unknown error');
        console.log(`❌ [DuckDuckGo] Intento ${attempt} falló:`, lastError.message);
        
        if (attempt === maxRetries) {
          throw lastError;
        }
      }
    }
    
    throw lastError || new Error('Fetch failed after retries');
  }

  /**
   * Realiza una búsqueda usando Tavily como fallback
   */
  private async searchWithTavilyFallback(options: DuckDuckGoSearchOptions): Promise<DuckDuckGoSearchResponse> {
    console.log(`🔄 [DuckDuckGo] Usando Tavily como fallback`);
    
    try {
      const searchQuery = this.buildSearchQuery(options);
      
      // Configurar opciones para Tavily con filtros de fecha
      const tavilyOptions: any = {
        search_depth: 'basic',
        max_results: options.maxResults || 20,
        include_answer: false,
        include_domains: options.site ? [options.site] : [],
      };

      // Agregar filtros temporales si están disponibles
      if (options.dateFrom || options.dateTo) {
        // Tavily usa un sistema de días hacia atrás
        if (options.dateFrom) {
          const daysAgo = this.calculateDaysAgo(options.dateFrom);
          if (daysAgo > 0) {
            tavilyOptions.days = Math.min(daysAgo, 365); // Máximo 1 año
          }
        }
      }

      const tavilyResult = await searchWithTavily(searchQuery, tavilyOptions);
      
      if (!tavilyResult.success || !tavilyResult.data?.results) {
        throw new Error('Tavily fallback también falló');
      }

      // Convertir resultados de Tavily al formato esperado (solo URLs básicas)
      const results: SearchResult[] = tavilyResult.data.results.map((item: any) => ({
        title: item.title || '',
        url: item.url || '',
        domain: item.url ? this.extractDomain(item.url) : '',
        publishedDate: undefined
      }));

      console.log(`✅ [DuckDuckGo] Fallback Tavily: ${results.length} resultados`);

      return {
        success: true,
        results,
        query: searchQuery,
        totalResults: results.length,
      };

    } catch (error) {
      console.error('❌ [DuckDuckGo] Error en fallback Tavily:', error);
      
      return {
        success: false,
        results: [],
        query: options.query,
        totalResults: 0,
        error: `Ambos métodos fallaron: ${error instanceof Error ? error.message : 'Error desconocido'}`
      };
    }
  }

  /**
   * Realiza una búsqueda inteligente (Tavily principal, DuckDuckGo como backup)
   */
  async search(options: DuckDuckGoSearchOptions): Promise<DuckDuckGoSearchResponse> {
    console.log(`🔍 [SmartSearch] Iniciando búsqueda inteligente: "${options.query}"`);
    
    // Usar Tavily como método principal ya que es más confiable
    try {
      console.log(`🎯 [SmartSearch] Usando Tavily como método principal`);
      const tavilyResult = await this.searchWithTavilyFallback(options);
      
      if (tavilyResult.success && tavilyResult.results.length > 0) {
        console.log(`✅ [SmartSearch] Tavily exitoso: ${tavilyResult.results.length} resultados`);
        return tavilyResult;
      }
      
      // Si Tavily falla, intentar DuckDuckGo como backup
      console.log(`⚠️ [SmartSearch] Tavily sin resultados, intentando DuckDuckGo`);
      return await this.searchDuckDuckGoDirectly(options);
      
    } catch (error) {
      console.error('❌ [SmartSearch] Error en búsqueda principal:', error);
      
      // Último intento con DuckDuckGo
      console.log(`🔄 [SmartSearch] Último intento con DuckDuckGo`);
      return await this.searchDuckDuckGoDirectly(options);
    }
  }

  /**
   * Método de búsqueda directo en DuckDuckGo (como backup)
   */
  private async searchDuckDuckGoDirectly(options: DuckDuckGoSearchOptions): Promise<DuckDuckGoSearchResponse> {
    console.log(`🦆 [DuckDuckGo] Intentando búsqueda directa como backup`);
    
    try {
      const searchUrl = this.buildSearchUrl(options);
      const searchQuery = this.buildSearchQuery(options);
      
      // Usar fetch directo con retry
      const html = await this.fetchHtmlWithRetry(searchUrl, 2);
      
      if (!html || html.length < 100) {
        throw new Error('Contenido HTML insuficiente');
      }

      // Parsear resultados
      const maxResults = options.maxResults || 20;
      const results = this.parseSearchResults(html, maxResults);

      if (results.length === 0) {
        throw new Error('No se encontraron resultados parseables');
      }

      console.log(`✅ [DuckDuckGo] Backup exitoso: ${results.length} resultados`);

      return {
        success: true,
        results,
        query: searchQuery,
        totalResults: results.length,
      };

    } catch (error) {
      console.error('❌ [DuckDuckGo] Backup también falló:', error);
      
      return {
        success: false,
        results: [],
        query: options.query,
        totalResults: 0,
        error: `Todos los métodos fallaron: ${error instanceof Error ? error.message : 'Error desconocido'}`
      };
    }
  }

  /**
   * Búsqueda específica para noticias de LLMs en Hacker News
   */
  async searchLLMNews(options: {
    dateFrom?: string;
    dateTo?: string;
    maxResults?: number;
    keywords?: string[];
  }): Promise<DuckDuckGoSearchResponse> {
    // Construir query específica para LLMs
    let query = 'LLM OR "large language model" OR GPT OR Claude OR "artificial intelligence" OR AI';
    
    if (options.keywords && options.keywords.length > 0) {
      query += ` AND (${options.keywords.join(' OR ')})`;
    }

    return this.search({
      query,
      site: 'news.ycombinator.com',
      dateFrom: options.dateFrom,
      dateTo: options.dateTo,
      maxResults: options.maxResults || 50,
      region: 'us-en'
    });
  }

  /**
   * Búsqueda genérica de noticias con filtros de fecha
   */
  async searchNews(options: {
    topic: string;
    dateFrom?: string;
    dateTo?: string;
    sources?: string[];
    maxResults?: number;
  }): Promise<DuckDuckGoSearchResponse> {
    let query = options.topic;
    
    // Si se especifican fuentes múltiples, crear query con OR
    if (options.sources && options.sources.length > 0) {
      const siteFilters = options.sources.map(source => `site:${source}`).join(' OR ');
      query += ` (${siteFilters})`;
    }

    return this.search({
      query,
      dateFrom: options.dateFrom,
      dateTo: options.dateTo,
      maxResults: options.maxResults || 30,
      region: 'us-en'
    });
  }
}
