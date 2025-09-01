export interface DuckDuckGoInstantAnswer {
  Heading?: string;
  Abstract?: string;
  AbstractText?: string;
  AbstractURL?: string;
  Image?: string;
  RelatedTopics?: any[];
  Results?: any[];
  Redirect?: string;
  Answer?: string;
  AnswerType?: string;
  Definition?: string;
  DefinitionSource?: string;
  DefinitionURL?: string;
  Entity?: string;
  Type?: string;
  meta?: {
    src_id?: string;
    src_name?: string;
    src_url?: string;
  };
}

export interface InstantSearchOptions {
  query: string;
  format?: 'json' | 'xml';
  no_html?: boolean;
  skip_disambig?: boolean;
  no_redirect?: boolean;
  t?: string; // appid for tracking
}

export interface InstantSearchResponse {
  success: boolean;
  data?: DuckDuckGoInstantAnswer;
  results?: any[];
  error?: string;
  query: string;
}

export class DuckDuckGoInstantApiService {
  private static instance: DuckDuckGoInstantApiService;
  private baseUrl = 'https://api.duckduckgo.com/';

  static getInstance(): DuckDuckGoInstantApiService {
    if (!DuckDuckGoInstantApiService.instance) {
      DuckDuckGoInstantApiService.instance = new DuckDuckGoInstantApiService();
    }
    return DuckDuckGoInstantApiService.instance;
  }

  /**
   * Builds the URL for DuckDuckGo Instant Answer API
   */
  private buildApiUrl(options: InstantSearchOptions): string {
    // Simplificar los parámetros - usar solo los esenciales
    const params = new URLSearchParams({
      q: options.query,
      format: 'json'
    });

    // Agregar parámetros opcionales solo si son necesarios
    if (options.no_html !== undefined) {
      params.append('no_html', options.no_html ? '1' : '0');
    }

    if (options.t) {
      params.append('t', options.t);
    }

    return `${this.baseUrl}?${params.toString()}`;
  }

  /**
   * Performs a search using DuckDuckGo Instant Answer API
   */
  async search(options: InstantSearchOptions): Promise<InstantSearchResponse> {
    console.log(`🦆 [DuckDuckGo Instant] Searching for: "${options.query}"`);
    
    try {
      const url = this.buildApiUrl(options);
      console.log(`🌐 [DuckDuckGo Instant] API URL: ${url}`);

      // Improved headers to avoid 403 errors
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'MyApp/1.0 (+https://api.example.com)',
          'Accept-Language': 'en-US,en;q=0.9',
          'Accept-Encoding': 'gzip, deflate, br',
          'Connection': 'keep-alive',
          'Cache-Control': 'no-cache',
        },
        signal: AbortSignal.timeout(15000) // 15 second timeout
      });

      console.log(`🔍 [DuckDuckGo Instant] Response status: ${response.status} ${response.statusText}`);

      if (!response.ok) {
        // Log detailed error information for debugging
        let errorBody = '';
        try {
          errorBody = await response.text();
          console.error(`❌ [DuckDuckGo Instant] Error response body:`, errorBody);
        } catch (e) {
          console.error(`❌ [DuckDuckGo Instant] Could not read error body`);
        }
        
        console.error(`❌ [DuckDuckGo Instant] Response headers:`, Object.fromEntries(response.headers.entries()));
        
        throw new Error(`HTTP ${response.status}: ${response.statusText}. Body: ${errorBody}`);
      }

      const data: DuckDuckGoInstantAnswer = await response.json();
      
      console.log(`✅ [DuckDuckGo Instant] API response received`);
      console.log(`📊 [DuckDuckGo Instant] Raw response data:`, JSON.stringify(data, null, 2));
      console.log(`📊 [DuckDuckGo Instant] Has Abstract: ${!!data.AbstractText}`);
      console.log(`📊 [DuckDuckGo Instant] Has Results: ${!!data.Results?.length}`);
      console.log(`📊 [DuckDuckGo Instant] Has RelatedTopics: ${!!data.RelatedTopics?.length}`);
      console.log(`📊 [DuckDuckGo Instant] Has Answer: ${!!data.Answer}`);
      console.log(`📊 [DuckDuckGo Instant] Has Definition: ${!!data.Definition}`);
      console.log(`📊 [DuckDuckGo Instant] AbstractText: ${data.AbstractText?.substring(0, 100)}...`);
      console.log(`📊 [DuckDuckGo Instant] Answer: ${data.Answer?.substring(0, 100)}...`);
      console.log(`📊 [DuckDuckGo Instant] Definition: ${data.Definition?.substring(0, 100)}...`);

      // Always return success if we got a response, even if it seems empty
      // Let the calling code decide what to do with the results
      console.log(`✅ [DuckDuckGo Instant] Returning response with ${data.Results?.length || 0} results`);
      
      return {
        success: true,
        data,
        results: data.Results || [],
        query: options.query
      };

    } catch (error) {
      console.error('❌ [DuckDuckGo Instant] Search error:', error);
      
      return {
        success: false,
        query: options.query,
        error: error instanceof Error ? error.message : 'Unknown error occurred'
      };
    }
  }

  /**
   * Performs a search with web results focus
   */
  async searchWebResults(query: string): Promise<InstantSearchResponse> {
    console.log(`🔍 [DuckDuckGo Instant] Searching web results for: "${query}"`);
    
    // Usar parámetros mínimos para obtener mejores resultados
    const options: InstantSearchOptions = {
      query,
      format: 'json'
      // Remover no_html, skip_disambig, no_redirect para obtener resultados más completos
    };

    const result = await this.search(options);
    
    if (result.success && result.data) {
      // Extract and format web results
      const webResults = this.extractWebResults(result.data);
      
      console.log(`📊 [DuckDuckGo Instant] Extracted ${webResults.length} web results from response`);
      
      // Always return results, even if empty, so we can see what the API actually returned
      return {
        ...result,
        results: webResults
      };
    }

    return result;
  }

  /**
   * Extracts web results from Instant Answer response
   */
  private extractWebResults(data: DuckDuckGoInstantAnswer): any[] {
    const results: any[] = [];

    console.log(`🔍 [DuckDuckGo Instant] Extracting results from:`, {
      hasAbstract: !!data.AbstractText,
      hasResults: !!data.Results?.length,
      hasRelatedTopics: !!data.RelatedTopics?.length,
      hasAnswer: !!data.Answer,
      hasDefinition: !!data.Definition
    });

    // Add Abstract as a result if available
    if (data.AbstractText && data.AbstractURL) {
      results.push({
        title: data.Heading || 'Abstract',
        url: data.AbstractURL,
        snippet: data.AbstractText,
        type: 'abstract',
        source: data.meta?.src_name || 'DuckDuckGo'
      });
      console.log(`📄 [DuckDuckGo Instant] Added abstract result`);
    }

    // Add Answer as a result if available
    if (data.Answer) {
      results.push({
        title: data.Heading || 'Answer',
        url: data.AbstractURL || '',
        snippet: data.Answer,
        type: 'answer',
        source: 'DuckDuckGo'
      });
      console.log(`💡 [DuckDuckGo Instant] Added answer result`);
    }

    // Add Definition as a result if available
    if (data.Definition) {
      results.push({
        title: data.Heading || 'Definition',
        url: data.DefinitionURL || '',
        snippet: data.Definition,
        type: 'definition',
        source: data.DefinitionSource || 'DuckDuckGo'
      });
      console.log(`📚 [DuckDuckGo Instant] Added definition result`);
    }

    // Add Results array
    if (data.Results && Array.isArray(data.Results)) {
      console.log(`📋 [DuckDuckGo Instant] Processing ${data.Results.length} Results`);
      data.Results.forEach((result: any, index: number) => {
        console.log(`📄 [DuckDuckGo Instant] Result ${index}:`, {
          hasFirstURL: !!result.FirstURL,
          hasText: !!result.Text,
          text: result.Text?.substring(0, 50) + '...'
        });
        
        if (result.FirstURL && result.Text) {
          results.push({
            title: result.Text,
            url: result.FirstURL,
            snippet: result.Text,
            type: 'result',
            source: 'DuckDuckGo'
          });
        }
      });
    }

    // Add RelatedTopics as results
    if (data.RelatedTopics && Array.isArray(data.RelatedTopics)) {
      console.log(`🔗 [DuckDuckGo Instant] Processing ${data.RelatedTopics.length} RelatedTopics`);
      data.RelatedTopics.forEach((topic: any, index: number) => {
        console.log(`🔗 [DuckDuckGo Instant] RelatedTopic ${index}:`, {
          hasFirstURL: !!topic.FirstURL,
          hasText: !!topic.Text,
          text: topic.Text?.substring(0, 50) + '...'
        });
        
        if (topic.FirstURL && topic.Text) {
          results.push({
            title: topic.Text,
            url: topic.FirstURL,
            snippet: topic.Text,
            type: 'related_topic',
            source: 'DuckDuckGo'
          });
        }
      });
    }

    console.log(`✅ [DuckDuckGo Instant] Total extracted results: ${results.length}`);
    return results;
  }

  /**
   * Performs a search with instant answer focus
   */
  async searchInstantAnswer(query: string): Promise<InstantSearchResponse> {
    console.log(`💡 [DuckDuckGo Instant] Searching instant answer for: "${query}"`);
    
    const options: InstantSearchOptions = {
      query,
      format: 'json',
      no_html: true,
      skip_disambig: false, // Allow disambiguation for better answers
      no_redirect: false
    };

    return await this.search(options);
  }

  /**
   * Test method to diagnose API issues with curl-like request
   */
  async testApiConnection(query: string = 'hello'): Promise<{success: boolean, details: any}> {
    console.log(`🧪 [DuckDuckGo Instant] Testing API connection with query: "${query}"`);
    
    try {
      const testUrl = `${this.baseUrl}?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
      console.log(`🔍 [DuckDuckGo Instant] Test URL: ${testUrl}`);

      const response = await fetch(testUrl, {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'MyApp/1.0 (+https://api.example.com)',
        },
        signal: AbortSignal.timeout(10000)
      });

      const details: any = {
        status: response.status,
        statusText: response.statusText,
        headers: Object.fromEntries(response.headers.entries()),
        url: testUrl,
        timestamp: new Date().toISOString()
      };

      if (!response.ok) {
        let errorBody = '';
        try {
          errorBody = await response.text();
          details.errorBody = errorBody;
        } catch (e) {
          details.errorBody = 'Could not read error body';
        }
        
        console.error(`❌ [DuckDuckGo Instant] Test failed:`, details);
        return { success: false, details };
      }

      const data = await response.json();
      details.responseData = data;
      
      console.log(`✅ [DuckDuckGo Instant] Test successful:`, details);
      return { success: true, details };

    } catch (error) {
      const details = {
        error: error instanceof Error ? error.message : 'Unknown error',
        timestamp: new Date().toISOString()
      };
      
      console.error(`❌ [DuckDuckGo Instant] Test error:`, details);
      return { success: false, details };
    }
  }
}

