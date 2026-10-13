import { fetchHtml } from '@/lib/utils/html-utils';
import { cleanHtmlContent } from '@/lib/utils/html-content-cleaner';
import { searchWeb, type WebSearchOptions } from '@/lib/services/search/web-search';
import { DuckDuckGoInstantApiService } from './duckduckgo-instant-api';

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
   * Usa la API oficial de DuckDuckGo Instant Answer para búsquedas
   */
  private async searchWithInstantApi(options: DuckDuckGoSearchOptions): Promise<DuckDuckGoSearchResponse> {
    try {
      console.log(`🦆 [DuckDuckGo Instant] Usando API oficial para: "${options.query}"`);
      
      const instantApiService = DuckDuckGoInstantApiService.getInstance();
      const searchQuery = this.buildSearchQuery(options);
      
      const result = await instantApiService.searchWebResults(searchQuery);
      
      if (result.success && result.results && result.results.length > 0) {
        // Convertir resultados al formato esperado
        const searchResults: SearchResult[] = result.results.map((item: any) => ({
          title: item.title || '',
          url: item.url || '',
          domain: item.url ? this.extractDomain(item.url) : '',
          publishedDate: undefined
        }));

        console.log(`✅ [DuckDuckGo Instant] API exitosa: ${searchResults.length} resultados`);
        
        return {
          success: true,
          results: searchResults,
          query: searchQuery,
          totalResults: searchResults.length,
        };
      }
      
      console.log(`⚠️ [DuckDuckGo Instant] API sin resultados útiles`);
      return {
        success: false,
        results: [],
        query: searchQuery,
        totalResults: 0,
        error: 'No results found'
      };
      
    } catch (error) {
      console.log(`❌ [DuckDuckGo Instant] API falló:`, error);
      return {
        success: false,
        results: [],
        query: options.query,
        totalResults: 0,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
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
   * Realiza una búsqueda usando el servicio de búsqueda web como fallback
   */
  private async searchWithWebSearchFallback(options: DuckDuckGoSearchOptions): Promise<DuckDuckGoSearchResponse> {
    console.log(`🔄 [WebSearch] Usando búsqueda web como fallback`);
    
    try {
      // No degradar requisitos de fecha a términos de query ni realizar una búsqueda sin filtro.
      if (options.dateFrom !== undefined || options.dateTo !== undefined) {
        throw new Error('Web search fallback does not support dateFrom/dateTo filters');
      }
      if (options.region !== undefined) {
        throw new Error('Web search fallback does not support region filters');
      }

      const searchQuery = this.buildSearchQuery(options);
      
      const searchOptions: WebSearchOptions = {
        search_depth: 'basic',
        max_results: Math.min(options.maxResults ?? 20, 20),
        include_answer: false,
        include_domains: options.site ? [options.site] : [],
      };

      const searchResult = await searchWeb(searchQuery, searchOptions);
      
      if (!searchResult.success) {
        throw new Error(searchResult.error || 'Web search fallback también falló');
      }
      if (!searchResult.data?.results) {
        throw new Error('Web search fallback también falló');
      }

      // Convertir resultados al formato esperado (solo URLs básicas)
      const results: SearchResult[] = searchResult.data.results.map((item: any) => ({
        title: item.title || '',
        url: item.url || '',
        domain: item.url ? this.extractDomain(item.url) : '',
        publishedDate: undefined
      }));

      console.log(`✅ [WebSearch] Fallback exitoso: ${results.length} resultados`);

      return {
        success: true,
        results,
        query: searchQuery,
        totalResults: results.length,
      };

    } catch (error) {
      console.error('❌ [WebSearch] Error en fallback:', error);
      
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
   * Realiza una búsqueda inteligente (DuckDuckGo Instant API principal, HTML scraping como backup, búsqueda web como fallback)
   */
  async search(options: DuckDuckGoSearchOptions): Promise<DuckDuckGoSearchResponse> {
    return this.searchWithDefaults(options);
  }

  /** Apply inherited regional preferences only to primary providers, not the fallback. */
  private async searchWithDefaults(
    options: DuckDuckGoSearchOptions,
    primaryDefaults: Pick<DuckDuckGoSearchOptions, 'region'> = {},
  ): Promise<DuckDuckGoSearchResponse> {
    console.log(`🔍 [SmartSearch] Iniciando búsqueda inteligente: "${options.query}"`);
    
    // Usar DuckDuckGo Instant API como método principal
    try {
      console.log(`🦆 [SmartSearch] Usando DuckDuckGo Instant API como método principal`);
      const instantApiResult = await this.searchWithInstantApi({ ...primaryDefaults, ...options });
      
      if (instantApiResult.success && instantApiResult.results.length > 0) {
        console.log(`✅ [SmartSearch] DuckDuckGo Instant API exitoso: ${instantApiResult.results.length} resultados`);
        return instantApiResult;
      }
      
      // Si Instant API falla, intentar HTML scraping como backup
      console.log(`⚠️ [SmartSearch] Instant API sin resultados, intentando HTML scraping`);
      const htmlResult = await this.searchDuckDuckGoDirectly({ ...primaryDefaults, ...options });
      
      if (htmlResult.success && htmlResult.results.length > 0) {
        console.log(`✅ [SmartSearch] HTML scraping exitoso: ${htmlResult.results.length} resultados`);
        return htmlResult;
      }
      
      console.log(`⚠️ [SmartSearch] HTML scraping sin resultados, intentando búsqueda web como fallback`);
      
    } catch (error) {
      console.error('❌ [SmartSearch] Error en búsqueda principal:', error);
    }

    // Un solo intento, fuera del catch de los proveedores principales.
    console.log(`🔄 [SmartSearch] Último intento con búsqueda web`);
    return await this.searchWithWebSearchFallback(options);
  }

  /**
   * Método de búsqueda directo en DuckDuckGo (método principal)
   */
  private async searchDuckDuckGoDirectly(options: DuckDuckGoSearchOptions): Promise<DuckDuckGoSearchResponse> {
    console.log(`🦆 [DuckDuckGo] Ejecutando búsqueda directa`);
    
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

      console.log(`✅ [DuckDuckGo] Búsqueda exitosa: ${results.length} resultados`);

      return {
        success: true,
        results,
        query: searchQuery,
        totalResults: results.length,
      };

    } catch (error) {
      console.error('❌ [DuckDuckGo] Búsqueda falló:', error);
      
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
    region?: string;
  }): Promise<DuckDuckGoSearchResponse> {
    // Construir query específica para LLMs
    let query = 'LLM OR "large language model" OR GPT OR Claude OR "artificial intelligence" OR AI';
    
    if (options.keywords && options.keywords.length > 0) {
      query += ` AND (${options.keywords.join(' OR ')})`;
    }

    return this.searchWithDefaults({
      query,
      site: 'news.ycombinator.com',
      dateFrom: options.dateFrom,
      dateTo: options.dateTo,
      maxResults: options.maxResults ?? 20,
      ...(options.region !== undefined ? { region: options.region } : {}),
    }, { region: 'us-en' });
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
    region?: string;
  }): Promise<DuckDuckGoSearchResponse> {
    let query = options.topic;
    
    // Si se especifican fuentes múltiples, crear query con OR
    if (options.sources && options.sources.length > 0) {
      const siteFilters = options.sources.map(source => `site:${source}`).join(' OR ');
      query += ` (${siteFilters})`;
    }

    return this.searchWithDefaults({
      query,
      dateFrom: options.dateFrom,
      dateTo: options.dateTo,
      maxResults: options.maxResults ?? 20,
      ...(options.region !== undefined ? { region: options.region } : {}),
    }, { region: 'us-en' });
  }
}
