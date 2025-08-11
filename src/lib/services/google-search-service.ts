import { searchWithTavily } from '@/lib/services/search/data-analyst-search';

export interface GoogleSearchOptions {
  query: string;
  site?: string; // e.g., "news.ycombinator.com"
  dateFrom?: string; // YYYY-MM-DD format
  dateTo?: string; // YYYY-MM-DD format
  maxResults?: number;
  country?: string; // e.g., "us"
  language?: string; // e.g., "en"
}

export interface SearchResult {
  title: string;
  url: string;
  domain: string;
  publishedDate?: string;
  snippet?: string; // Google lo proporciona automáticamente
}

export interface GoogleSearchResponse {
  success: boolean;
  results: SearchResult[];
  query: string;
  totalResults: number;
  error?: string;
  method: 'google' | 'tavily' | 'serpapi';
}

export class GoogleSearchService {
  private static instance: GoogleSearchService;
  private googleApiKey: string;
  private googleCseId: string;
  private serpApiKey?: string;

  constructor() {
    this.googleApiKey = process.env.GOOGLE_CLOUD_API_KEY || process.env.GOOGLE_API_KEY || '';
    this.googleCseId = process.env.GOOGLE_CSE_ID || '';
    this.serpApiKey = process.env.SERPAPI_KEY;
  }

  static getInstance(): GoogleSearchService {
    if (!GoogleSearchService.instance) {
      GoogleSearchService.instance = new GoogleSearchService();
    }
    return GoogleSearchService.instance;
  }

  /**
   * Construye la query de búsqueda con filtros de fecha y sitio
   */
  private buildSearchQuery(options: GoogleSearchOptions): string {
    let query = options.query;

    // Agregar filtro de sitio si se especifica
    if (options.site) {
      query += ` site:${options.site}`;
    }

    return query.trim();
  }

  /**
   * Calcula el rango de fechas para Google Search
   */
  private calculateDateRange(dateFrom?: string, dateTo?: string): string | undefined {
    if (!dateFrom && !dateTo) return undefined;
    
    const from = dateFrom || '2020-01-01';
    const to = dateTo || new Date().toISOString().split('T')[0];
    
    return `date:r:${from}:${to}`;
  }

  /**
   * Busca usando Google Custom Search API
   */
  private async searchWithGoogle(options: GoogleSearchOptions): Promise<GoogleSearchResponse> {
    console.log(`🔍 [Google] Iniciando búsqueda: "${options.query}"`);

    if (!this.googleApiKey || !this.googleCseId) {
      throw new Error('Google API Key y CSE ID son requeridos');
    }

    try {
      const searchQuery = this.buildSearchQuery(options);
      const dateRange = this.calculateDateRange(options.dateFrom, options.dateTo);
      
      // Construir URL de Google Custom Search API
      const baseUrl = 'https://www.googleapis.com/customsearch/v1';
      const params = new URLSearchParams({
        key: this.googleApiKey,
        cx: this.googleCseId,
        q: searchQuery,
        num: Math.min(options.maxResults || 10, 10).toString(), // Máximo 10 por request
        safe: 'off',
        dateRestrict: dateRange ? this.convertToDateRestrict(options.dateFrom, options.dateTo) : ''
      });

      // Agregar filtros adicionales
      if (options.country) {
        params.set('gl', options.country);
      }
      if (options.language) {
        params.set('hl', options.language);
      }

      const url = `${baseUrl}?${params.toString()}`;
      console.log(`🌐 [Google] URL de búsqueda: ${url.substring(0, 150)}...`);

      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; NewsBot/1.0)',
        },
        signal: AbortSignal.timeout(15000)
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Google API Error: ${response.status} - ${errorText}`);
      }

      const data = await response.json();
      
      if (data.error) {
        throw new Error(`Google API Error: ${data.error.message}`);
      }

      // Procesar resultados
      const results: SearchResult[] = (data.items || []).map((item: any) => ({
        title: item.title || '',
        url: item.link || '',
        domain: this.extractDomain(item.link || ''),
        snippet: item.snippet || '',
        publishedDate: this.extractPublishedDate(item)
      }));

      console.log(`✅ [Google] Encontrados ${results.length} resultados`);

      return {
        success: true,
        results,
        query: searchQuery,
        totalResults: parseInt(data.searchInformation?.totalResults || '0'),
        method: 'google'
      };

    } catch (error) {
      console.error('❌ [Google] Error en búsqueda:', error);
      throw error;
    }
  }

  /**
   * Convierte fechas a formato dateRestrict de Google
   */
  private convertToDateRestrict(dateFrom?: string, dateTo?: string): string {
    if (!dateFrom && !dateTo) return '';
    
    if (dateFrom && !dateTo) {
      // Solo fecha desde - buscar últimos N días
      const daysAgo = this.calculateDaysAgo(dateFrom);
      return `d${Math.max(1, daysAgo)}`;
    }
    
    if (!dateFrom && dateTo) {
      // Solo fecha hasta - buscar últimos 30 días por defecto
      return 'd30';
    }
    
    // Ambas fechas - calcular días entre ellas
    const daysAgo = this.calculateDaysAgo(dateFrom!);
    return `d${Math.max(1, daysAgo)}`;
  }

  /**
   * Calcula días transcurridos desde una fecha
   */
  private calculateDaysAgo(dateString: string): number {
    try {
      const date = new Date(dateString);
      const now = new Date();
      const diffTime = now.getTime() - date.getTime();
      const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
      return Math.max(1, diffDays);
    } catch {
      return 30; // Default a 30 días
    }
  }

  /**
   * Busca usando SerpAPI como alternativa
   */
  private async searchWithSerpAPI(options: GoogleSearchOptions): Promise<GoogleSearchResponse> {
    console.log(`🐍 [SerpAPI] Iniciando búsqueda: "${options.query}"`);

    if (!this.serpApiKey) {
      throw new Error('SerpAPI Key es requerida');
    }

    try {
      const searchQuery = this.buildSearchQuery(options);
      
      const params = new URLSearchParams({
        api_key: this.serpApiKey,
        engine: 'google',
        q: searchQuery,
        num: Math.min(options.maxResults || 10, 100).toString(),
        google_domain: 'google.com',
        gl: options.country || 'us',
        hl: options.language || 'en'
      });

      // Agregar filtros de fecha
      if (options.dateFrom || options.dateTo) {
        const dateFilter = this.convertToDateRestrict(options.dateFrom, options.dateTo);
        if (dateFilter) {
          params.set('tbs', `qdr:${dateFilter}`);
        }
      }

      const url = `https://serpapi.com/search?${params.toString()}`;
      
      const response = await fetch(url, {
        method: 'GET',
        signal: AbortSignal.timeout(15000)
      });

      if (!response.ok) {
        throw new Error(`SerpAPI Error: ${response.status}`);
      }

      const data = await response.json();
      
      if (data.error) {
        throw new Error(`SerpAPI Error: ${data.error}`);
      }

      // Procesar resultados
      const results: SearchResult[] = (data.organic_results || []).map((item: any) => ({
        title: item.title || '',
        url: item.link || '',
        domain: this.extractDomain(item.link || ''),
        snippet: item.snippet || '',
        publishedDate: item.date || undefined
      }));

      console.log(`✅ [SerpAPI] Encontrados ${results.length} resultados`);

      return {
        success: true,
        results,
        query: searchQuery,
        totalResults: data.search_information?.total_results || results.length,
        method: 'serpapi'
      };

    } catch (error) {
      console.error('❌ [SerpAPI] Error en búsqueda:', error);
      throw error;
    }
  }

  /**
   * Busca usando Tavily como fallback
   */
  private async searchWithTavilyFallback(options: GoogleSearchOptions): Promise<GoogleSearchResponse> {
    console.log(`🔄 [Tavily] Usando Tavily como fallback`);
    
    try {
      const searchQuery = this.buildSearchQuery(options);
      
      // Configurar opciones para Tavily
      const tavilyOptions: any = {
        search_depth: 'basic',
        max_results: options.maxResults || 10,
        include_answer: false,
        include_domains: options.site ? [options.site] : [],
      };

      // Agregar filtro temporal
      if (options.dateFrom) {
        const daysAgo = this.calculateDaysAgo(options.dateFrom);
        tavilyOptions.days = Math.min(daysAgo, 365);
      }

      const tavilyResult = await searchWithTavily(searchQuery, tavilyOptions);
      
      if (!tavilyResult.success || !tavilyResult.data?.results) {
        throw new Error('Tavily fallback falló');
      }

      // Convertir resultados
      const results: SearchResult[] = tavilyResult.data.results.map((item: any) => ({
        title: item.title || '',
        url: item.url || '',
        domain: this.extractDomain(item.url || ''),
        snippet: item.content?.substring(0, 200) || '',
        publishedDate: undefined
      }));

      console.log(`✅ [Tavily] Fallback exitoso: ${results.length} resultados`);

      return {
        success: true,
        results,
        query: searchQuery,
        totalResults: results.length,
        method: 'tavily'
      };

    } catch (error) {
      console.error('❌ [Tavily] Error en fallback:', error);
      throw error;
    }
  }

  /**
   * Extrae dominio de una URL
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
   * Intenta extraer fecha de publicación del resultado de Google
   */
  private extractPublishedDate(item: any): string | undefined {
    // Google a veces incluye metadata de fecha
    if (item.pagemap?.metatags?.[0]?.['article:published_time']) {
      return item.pagemap.metatags[0]['article:published_time'].split('T')[0];
    }
    
    if (item.pagemap?.metatags?.[0]?.['datePublished']) {
      return item.pagemap.metatags[0]['datePublished'].split('T')[0];
    }
    
    return undefined;
  }

  /**
   * Método principal de búsqueda con estrategia inteligente
   */
  async search(options: GoogleSearchOptions): Promise<GoogleSearchResponse> {
    console.log(`🚀 [GoogleSearch] Iniciando búsqueda inteligente: "${options.query}"`);
    
    try {
      // Primero intentar con Google Custom Search API
      if (this.googleApiKey && this.googleCseId) {
        console.log(`🔍 [GoogleSearch] Usando Google Custom Search API`);
        return await this.searchWithGoogle(options);
      }
      
      // Si no hay Google API, intentar SerpAPI
      if (this.serpApiKey) {
        console.log(`🐍 [GoogleSearch] Usando SerpAPI como alternativa`);
        return await this.searchWithSerpAPI(options);
      }
      
      // Fallback a Tavily
      console.log(`🔄 [GoogleSearch] Usando Tavily como fallback`);
      return await this.searchWithTavilyFallback(options);
      
    } catch (error) {
      console.error('❌ [GoogleSearch] Error en método principal, usando fallback:', error);
      
      // Intentar el siguiente método disponible
      try {
        if (this.serpApiKey && !error.message.includes('SerpAPI')) {
          return await this.searchWithSerpAPI(options);
        }
        return await this.searchWithTavilyFallback(options);
      } catch (fallbackError) {
        return {
          success: false,
          results: [],
          query: options.query,
          totalResults: 0,
          method: 'tavily',
          error: `Todos los métodos fallaron: ${error instanceof Error ? error.message : 'Error desconocido'}`
        };
      }
    }
  }

  /**
   * Búsqueda específica para noticias de LLMs
   */
  async searchLLMNews(options: {
    dateFrom?: string;
    dateTo?: string;
    maxResults?: number;
    keywords?: string[];
  }): Promise<GoogleSearchResponse> {
    let query = 'LLM OR "large language model" OR GPT OR Claude OR "artificial intelligence"';
    
    if (options.keywords && options.keywords.length > 0) {
      query += ` AND (${options.keywords.join(' OR ')})`;
    }

    return this.search({
      query,
      site: 'news.ycombinator.com',
      dateFrom: options.dateFrom,
      dateTo: options.dateTo,
      maxResults: options.maxResults || 50,
      country: 'us',
      language: 'en'
    });
  }

  /**
   * Búsqueda general de noticias
   */
  async searchNews(options: {
    topic: string;
    dateFrom?: string;
    dateTo?: string;
    sources?: string[];
    maxResults?: number;
  }): Promise<GoogleSearchResponse> {
    let query = options.topic;
    
    // Si hay múltiples fuentes, hacer búsquedas por separado y combinar
    if (options.sources && options.sources.length > 1) {
      const results: SearchResult[] = [];
      let totalResults = 0;
      
      for (const source of options.sources.slice(0, 3)) { // Limitar a 3 fuentes
        try {
          const sourceResult = await this.search({
            query,
            site: source,
            dateFrom: options.dateFrom,
            dateTo: options.dateTo,
            maxResults: Math.floor((options.maxResults || 30) / options.sources.length),
            country: 'us'
          });
          
          if (sourceResult.success) {
            results.push(...sourceResult.results);
            totalResults += sourceResult.totalResults;
          }
        } catch (error) {
          console.warn(`⚠️ [GoogleSearch] Error en fuente ${source}:`, error);
        }
      }
      
      return {
        success: results.length > 0,
        results: results.slice(0, options.maxResults || 30),
        query,
        totalResults,
        method: 'google'
      };
    }

    return this.search({
      query,
      site: options.sources?.[0],
      dateFrom: options.dateFrom,
      dateTo: options.dateTo,
      maxResults: options.maxResults || 30,
      country: 'us'
    });
  }
}
