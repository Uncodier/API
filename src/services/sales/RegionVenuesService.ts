import { systemMemoryService } from '@/lib/services/system-memory-service';

// Interfaces para la búsqueda de venues
export interface Venue {
  id: string;
  name: string;
  address: string;
  phone: string;
  international_phone?: string;
  website: string;
  google_maps_url?: string;
  business_status?: string;
  rating: string;
  total_ratings?: number;
  price_level?: number;
  types: string[];
  location: {
    lat: number;
    lng: number;
  };
  opening_hours: {
    open_now: boolean;
    periods?: any[];
    weekday_text?: string[];
  };
  amenities: string[];
  description?: string;
  reviews?: Array<{
    author_name: string;
    rating: number;
    text: string;
    time: number;
  }>;
  photos?: Array<{
    photo_reference: string;
    width: number;
    height: number;
  }>;
}

export interface VenueSearchResult {
  success: boolean;
  venues?: Venue[];
  error?: string;
}



export interface VenueSearchParams {
  siteId: string;
  userId?: string;
  searchTerm: string;
  city: string;
  region: string;
  country?: string;
  limit?: number;
  excludeVenues?: {
    placeIds?: string[];
    names?: string[];
  };
}

/**
 * Servicio para buscar venues en una región usando Google Maps API
 */
export class RegionVenuesService {
  private readonly googleApiKey = process.env.GOOGLE_CLOUD_API_KEY;
  private readonly placesApiUrl = 'https://maps.googleapis.com/maps/api/place';
  private readonly geocodingApiUrl = 'https://maps.googleapis.com/maps/api/geocode/json';

  constructor() {
    if (!this.googleApiKey) {
      console.error('❌ GOOGLE_CLOUD_API_KEY is not configured');
      console.error('   Make sure you have this variable in your .env.local file');
      console.error('   Example: GOOGLE_CLOUD_API_KEY=your_api_key_here');
      throw new Error('GOOGLE_CLOUD_API_KEY is not configured');
    }
    
    console.log('✅ Google Maps API service initialized');
    console.log('   API Key configured:', this.googleApiKey.substring(0, 10) + '...');
  }

  /**
   * Valida los parámetros de búsqueda
   */
  validateSearchParams(params: VenueSearchParams): { valid: boolean; error?: string } {
    if (!params.searchTerm || params.searchTerm.trim().length === 0) {
      return { valid: false, error: 'Search term is required' };
    }
    
    if (!params.city || params.city.trim().length === 0) {
      return { valid: false, error: 'City is required' };
    }
    
    if (!params.region || params.region.trim().length === 0) {
      return { valid: false, error: 'Region is required' };
    }
    
    if (!params.siteId) {
      return { valid: false, error: 'siteId is required' };
    }
    
    return { valid: true };
  }

  /**
   * Genera una clave única para las memorias del sistema
   */
  private generateMemoryKey(searchTerm: string, city: string, region: string): string {
    return `${searchTerm.toLowerCase().trim()}:${city.toLowerCase().trim()}:${region.toLowerCase().trim()}`;
  }

  /**
   * Consulta las memorias del sistema para obtener venues que no dieron resultados
   * Busca en 3 niveles: sitio específico, misma ciudad:región de otros sitios, y otras regiones de la misma ciudad
   */
  private async getFailedVenuesFromMemory(siteId: string, searchTerm: string, city: string, region: string): Promise<string[]> {
    try {
      const allExcludedNames: string[] = [];
      
      // 1. Memorias del sitio específico (búsqueda original)
      const cityRegionKey = `${city.toLowerCase().trim()}:${region.toLowerCase().trim()}`;
      
      console.log(`🧠 [Nivel 1] Buscando memorias del sitio específico: ${siteId}`);
      const siteMemoryResult = await systemMemoryService.findMemory({
        siteId,
        systemType: 'venue_failed_names',
        key: cityRegionKey
      });
      
      if (siteMemoryResult.success && siteMemoryResult.memory) {
        const siteExcludedNames = siteMemoryResult.memory.data.excludedNames || [];
        allExcludedNames.push(...siteExcludedNames);
        console.log(`🧠 [Nivel 1] Encontradas ${siteExcludedNames.length} memorias del sitio específico`);
      }
      
      // 2. Memorias de la misma ciudad:región exacta de otros sitios
      console.log(`🧠 [Nivel 2] Buscando memorias de la misma región exacta de otros sitios: ${city}:${region}`);
      const regionMemoriesResult = await systemMemoryService.findMemoriesGlobal(
        'venue_failed_names',
        cityRegionKey
      );
      
      if (regionMemoriesResult.success && regionMemoriesResult.memories) {
        let regionExcludedCount = 0;
        regionMemoriesResult.memories.forEach(memory => {
          // Solo incluir memorias de otros sitios (no del actual)
          if (memory.siteId !== siteId) {
            const regionExcludedNames = memory.data.excludedNames || [];
            allExcludedNames.push(...regionExcludedNames);
            regionExcludedCount += regionExcludedNames.length;
          }
        });
        console.log(`🧠 [Nivel 2] Encontradas ${regionExcludedCount} memorias de la región exacta de otros sitios`);
      }
      
      // 3. Memorias de la misma ciudad (cualquier región) de otros sitios
      console.log(`🧠 [Nivel 3] Buscando memorias de la ciudad de todos los sitios: ${city}:*`);
      const cityMemoriesResult = await systemMemoryService.findMemoriesGlobalByPattern(
        'venue_failed_names',
        `${city.toLowerCase().trim()}:%`
      );
      
      if (cityMemoriesResult.success && cityMemoriesResult.memories) {
        let cityExcludedCount = 0;
        cityMemoriesResult.memories.forEach(memory => {
          // Solo incluir memorias de otros sitios y otras regiones (no la región actual)
          if (memory.siteId !== siteId && memory.key !== cityRegionKey) {
            const cityExcludedNames = memory.data.excludedNames || [];
            allExcludedNames.push(...cityExcludedNames);
            cityExcludedCount += cityExcludedNames.length;
          }
        });
        console.log(`🧠 [Nivel 3] Encontradas ${cityExcludedCount} memorias de otras regiones de la ciudad de otros sitios`);
      }
      
      // Eliminar duplicados y retornar
      const uniqueExcludedNames = Array.from(new Set(allExcludedNames));
      console.log(`🧠 [Resumen] Total venues a excluir: ${uniqueExcludedNames.length} únicos de ${allExcludedNames.length} totales`);
      console.log(`🧠 [Detalle] Niveles - Sitio específico: ${siteMemoryResult.memory?.data.excludedNames?.length || 0}, Misma región de otros sitios: ${regionMemoriesResult.memories?.length || 0}, Otras regiones de la ciudad: ${cityMemoriesResult.memories?.length || 0}`);
      
      return uniqueExcludedNames;
    } catch (error) {
      console.error('Error getting failed venues from memory:', error);
      return [];
    }
  }

  /**
   * Guarda en memoria cuando una búsqueda no dio resultados
   */
  private async saveNoResultsToMemory(siteId: string, searchTerm: string, city: string, region: string): Promise<void> {
    try {
      const memoryKey = this.generateMemoryKey(searchTerm, city, region);
      
      // Verificar si ya existe una memoria para esta búsqueda
      const existingMemory = await systemMemoryService.findMemory({
        siteId,
        systemType: 'venue_search_no_results',
        key: memoryKey
      });
      
      const memoryData = {
        searchTerm,
        city,
        region,
        noResults: true,
        timestamp: new Date().toISOString(),
        searchConditions: {
          searchTerm: searchTerm.toLowerCase().trim(),
          city: city.toLowerCase().trim(),
          region: region.toLowerCase().trim()
        }
      };
      
      // Expirar la memoria después de 7 días
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + 7);
      
      if (existingMemory.success && existingMemory.memory) {
        // Actualizar memoria existente
        await systemMemoryService.updateMemory(
          {
            siteId,
            systemType: 'venue_search_no_results',
            key: memoryKey
          },
          {
            data: memoryData,
            expiresAt
          }
        );
        console.log(`🧠 Updated system memory for no-results search: ${searchTerm} in ${city}, ${region}`);
      } else {
        // Crear nueva memoria
        await systemMemoryService.createMemory({
          siteId,
          systemType: 'venue_search_no_results',
          key: memoryKey,
          data: memoryData,
          expiresAt
        });
        console.log(`🧠 Created system memory for no-results search: ${searchTerm} in ${city}, ${region}`);
      }
    } catch (error) {
      console.error('Error saving no-results to memory:', error);
    }
  }

  /**
   * Verifica si una búsqueda ya está marcada como sin resultados en memoria
   * Busca en 3 niveles: sitio específico, misma ciudad:región de otros sitios, y otras regiones de la misma ciudad
   */
  private async isSearchMarkedAsNoResults(siteId: string, searchTerm: string, city: string, region: string): Promise<boolean> {
    try {
      const memoryKey = this.generateMemoryKey(searchTerm, city, region);
      
      // 1. Verificar memorias del sitio específico
      console.log(`🧠 [NoResults-Nivel 1] Verificando sitio específico: ${siteId}`);
      const siteMemoryResult = await systemMemoryService.findMemory({
        siteId,
        systemType: 'venue_search_no_results',
        key: memoryKey
      });
      
      if (siteMemoryResult.success && siteMemoryResult.memory) {
        const isNoResults = siteMemoryResult.memory.data.noResults === true;
        if (isNoResults) {
          console.log(`🧠 [NoResults-Nivel 1] Búsqueda marcada como sin resultados en sitio específico: ${searchTerm} in ${city}, ${region}`);
          return true;
        }
      }
      
      // 2. Verificar memorias de la misma ciudad:región exacta en otros sitios
      console.log(`🧠 [NoResults-Nivel 2] Verificando misma región exacta en otros sitios`);
      const regionNoResultsResult = await systemMemoryService.findMemoriesGlobal(
        'venue_search_no_results',
        memoryKey
      );
      
      if (regionNoResultsResult.success && regionNoResultsResult.memories) {
        for (const memory of regionNoResultsResult.memories) {
          // Solo verificar memorias de otros sitios
          if (memory.siteId !== siteId && memory.data.noResults === true) {
            console.log(`🧠 [NoResults-Nivel 2] Búsqueda marcada como sin resultados en otro sitio: ${searchTerm} in ${city}, ${region}`);
            return true;
          }
        }
      }
      
      // 3. Verificar memorias de búsquedas en la misma ciudad (cualquier región)
      const citySearchPattern = `%:${city.toLowerCase().trim()}:%`;
      console.log(`🧠 [NoResults-Nivel 3] Verificando búsquedas en la misma ciudad (otras regiones)`);
      const cityNoResultsResult = await systemMemoryService.findMemoriesGlobalByPattern(
        'venue_search_no_results',
        citySearchPattern
      );
      
      if (cityNoResultsResult.success && cityNoResultsResult.memories) {
        for (const memory of cityNoResultsResult.memories) {
          // Solo verificar memorias de otros sitios y otras regiones
          if (memory.siteId !== siteId && memory.key !== memoryKey && memory.data.noResults === true) {
            console.log(`🧠 [NoResults-Nivel 3] Búsqueda similar marcada como sin resultados en otra región: ${memory.key}`);
            return true;
          }
        }
      }
      
      return false;
    } catch (error) {
      console.error('Error checking no-results memory:', error);
      return false;
    }
  }

  /**
   * Limpia memorias expiradas para el sitio
   */
  private async cleanupExpiredMemories(siteId: string): Promise<void> {
    try {
      const cleanupResult = await systemMemoryService.cleanupExpiredMemories(siteId);
      if (cleanupResult.success && cleanupResult.deletedCount && cleanupResult.deletedCount > 0) {
        console.log(`🧹 Cleaned up ${cleanupResult.deletedCount} expired venue search memories`);
      }
    } catch (error) {
      console.error('Error cleaning up expired memories:', error);
    }
  }

  /**
   * Busca coordenadas de una ubicación usando Google Geocoding API
   */
  private async geocodeLocation(city: string, region: string, country?: string): Promise<{ lat: number; lng: number } | null> {
    try {
      // Limpiar y normalizar los nombres de ubicación
      const cleanCity = city.trim();
      const cleanRegion = region.trim();
      const cleanCountry = country?.trim();
      
      // Construir múltiples variaciones de consulta para mejorar precisión
      const queries = [];
      
      // Si tenemos país específico, probar diferentes combinaciones
      if (cleanCountry) {
        queries.push(`${cleanCity}, ${cleanCountry}`);  // Sin región primero
        queries.push(`${cleanCity}, ${cleanRegion}, ${cleanCountry}`);
        
        // Para Argentina, agregar variaciones específicas
        if (cleanCountry.toLowerCase() === 'argentina') {
          queries.push(`${cleanCity}, Argentina`);
          queries.push(`Córdoba, Argentina`); // Con tilde
          if (cleanCity.toLowerCase().includes('cordoba')) {
            queries.push(`Córdoba Capital, Argentina`);
            queries.push(`Córdoba, Córdoba, Argentina`);
          }
        }
      } else {
        queries.push(`${cleanCity}, ${cleanRegion}`);
      }
      
      console.log(`🔍 Trying geocoding with ${queries.length} query variations:`, queries);
      
      // Probar cada consulta hasta encontrar una válida
      for (let i = 0; i < queries.length; i++) {
        const query = queries[i];
        const url = `${this.geocodingApiUrl}?address=${encodeURIComponent(query)}&key=${this.googleApiKey}`;
        
        console.log(`🌍 [Attempt ${i + 1}/${queries.length}] GEOCODING URL: ${url.replace(this.googleApiKey || '', '[API_KEY_HIDDEN]')}`);
        
        try {
          const response = await fetch(url);
          
          if (!response.ok) {
            console.error(`❌ HTTP error in geocoding request ${i + 1}:`, response.status, response.statusText);
            continue; // Try next query
          }
          
          const data = await response.json();
          
          console.log(`📊 [Attempt ${i + 1}] Geocoding API response status:`, data.status);
          console.log(`🔍 [Attempt ${i + 1}] FULL Geocoding API response:`, {
            query,
            status: data.status,
            results_count: data.results?.length || 0,
            first_result: data.results?.[0] ? {
              formatted_address: data.results[0].formatted_address,
              place_id: data.results[0].place_id,
              types: data.results[0].types,
              location: data.results[0].geometry?.location
            } : null
          });
          
          if (data.status === 'REQUEST_DENIED') {
            console.error('❌ Google Geocoding API Request Denied');
            console.error('   Error message:', data.error_message);
            console.error('   Common causes:');
            console.error('   1. API key is not valid');
            console.error('   2. Geocoding API is not enabled');
            console.error('   3. Billing is not enabled');
            console.error('   4. API key has restrictions that prevent this request');
            return null; // Stop trying if access is denied
          }
          
          if (data.status === 'OVER_QUERY_LIMIT') {
            console.error('❌ Google Geocoding API quota exceeded');
            console.error('   Error message:', data.error_message);
            return null; // Stop trying if quota exceeded
          }
          
          if (data.status === 'OK' && data.results && data.results.length > 0) {
            const location = data.results[0].geometry.location;
            console.log(`✅ [Attempt ${i + 1}] Geocoding successful for "${query}":`, location);
            
            // Validar que las coordenadas estén en el rango esperado para el país
            if (cleanCountry?.toLowerCase() === 'argentina') {
              // Argentina está aproximadamente entre latitudes -55 y -21, longitudes -73 y -53
              if (location.lat >= -55 && location.lat <= -21 && location.lng >= -73 && location.lng <= -53) {
                console.log(`✅ Coordinates validated for Argentina:`, location);
                return {
                  lat: location.lat,
                  lng: location.lng
                };
              } else {
                console.warn(`⚠️ Coordinates seem outside Argentina bounds:`, location, `- trying next query`);
                continue; // Try next query
              }
            } else {
              // Para otros países, usar el primer resultado válido
              return {
                lat: location.lat,
                lng: location.lng
              };
            }
          } else {
            console.error(`❌ [Attempt ${i + 1}] No results found for location:`, query, 'Status:', data.status);
            if (data.error_message) {
              console.error('   Error message:', data.error_message);
            }
            continue; // Try next query
          }
        } catch (queryError) {
          console.error(`❌ Error in geocoding query ${i + 1}:`, queryError);
          continue; // Try next query
        }
      }
      
      // Si ninguna consulta funcionó
      console.error(`❌ All geocoding attempts failed for: ${cleanCity}, ${cleanRegion}, ${cleanCountry}`);
      return null;
      
    } catch (error) {
      console.error('❌ Error in geocoding request:', error);
      return null;
    }
  }

  /**
   * Normaliza el searchTerm (solo limpieza básica de espacios)
   */
  private cleanSearchTerm(searchTerm: string): string {
    // Solo limpieza básica de espacios - sin extracción de texto
    return searchTerm.trim().replace(/\s+/g, ' ');
  }

  /**
   * Busca venues usando Google Places API - Text Search (más directo, sin geocoding)
   */
  private async searchWithTextSearch(
    searchTerm: string,
    city: string,
    region: string,
    country: string | undefined,
    limit: number,
    excludeVenues?: { placeIds?: string[]; names?: string[] }
  ): Promise<VenueSearchResult> {
    try {
      // Construir query de texto directo
      const locationPart = country ? `${city}, ${region}, ${country}` : `${city}, ${region}`;
      const query = `${searchTerm} ${locationPart}`;
      
      const url = `${this.placesApiUrl}/textsearch/json?query=${encodeURIComponent(query)}&key=${this.googleApiKey}`;
      
      console.log(`📝 [Text Search] Query: "${query}"`);
      console.log(`📝 [Text Search] URL: ${url.replace(this.googleApiKey || '', '[API_KEY_HIDDEN]')}`);
      
      const response = await fetch(url);
      
      if (!response.ok) {
        console.error('❌ [Text Search] HTTP error:', response.status, response.statusText);
        return {
          success: false,
          error: `Google Places Text Search HTTP error: ${response.status} ${response.statusText}`
        };
      }

      const data = await response.json();
      
      console.log('📊 [Text Search] API response status:', data.status);
      
      if (data.status === 'REQUEST_DENIED') {
        console.error('❌ [Text Search] Google Places API Request Denied');
        console.error('   Error message:', data.error_message);
        console.error('   Note: Text Search might not be enabled for this API key');
        return {
          success: false,
          error: `Google Places Text Search access denied: ${data.error_message || 'Check API key permissions for Text Search'}`
        };
      }
      
      if (data.status === 'OVER_QUERY_LIMIT') {
        console.error('❌ [Text Search] Google Places API quota exceeded');
        return {
          success: false,
          error: `Google Places Text Search quota exceeded: ${data.error_message || 'Check billing and quota limits'}`
        };
      }

      if (data.status !== 'OK' && data.status !== 'ZERO_RESULTS') {
        console.error('❌ [Text Search] Google Places API returned unexpected status:', data.status);
        return {
          success: false,
          error: `Google Places Text Search error: ${data.status} - ${data.error_message || 'Unknown error'}`
        };
      }

      if (!data.results || data.results.length === 0) {
        console.log('ℹ️ [Text Search] No venues found for the search criteria');
        return {
          success: true,
          venues: []
        };
      }

      console.log(`✅ [Text Search] Found ${data.results.length} venues from Places API`);

      // Filtrar venues excluidos antes de procesar
      let filteredResults = data.results;
      
      if (excludeVenues) {
        const originalCount = filteredResults.length;
        
        console.log(`🚫 [Text Search] Processing exclusions for ${originalCount} venues:`, {
          excludePlaceIds: excludeVenues.placeIds || [],
          excludeNames: excludeVenues.names || []
        });
        
        // Filtrar por Place IDs
        if (excludeVenues.placeIds && excludeVenues.placeIds.length > 0) {
          filteredResults = filteredResults.filter((place: any) => 
            !excludeVenues.placeIds!.includes(place.place_id)
          );
        }
        
        // Filtrar por nombres (case-insensitive)
        if (excludeVenues.names && excludeVenues.names.length > 0) {
          const excludeNamesLower = excludeVenues.names.map(name => name.toLowerCase().trim());
          
          filteredResults = filteredResults.filter((place: any) => {
            const placeName = place.name?.toLowerCase().trim();
            const shouldExclude = excludeNamesLower.includes(placeName);
            if (shouldExclude) {
              console.log(`🚫 [Text Search] EXCLUDING venue: "${place.name}"`);
            }
            return !shouldExclude;
          });
        }
        
        const excludedCount = originalCount - filteredResults.length;
        if (excludedCount > 0) {
          console.log(`🚫 [Text Search] Excluded ${excludedCount} venues based on exclusion criteria`);
        }
      }

      // Convertir resultados de Google Places a nuestro formato
      const venues = await Promise.all(
        filteredResults
          .slice(0, limit)
          .map(async (place: any) => await this.mapGooglePlaceToVenue(place))
      );

      const validVenues = venues.filter(venue => venue !== null);
      console.log(`✅ [Text Search] Successfully processed ${validVenues.length} venues`);

      return {
        success: true,
        venues: validVenues
      };
    } catch (error) {
      console.error('❌ [Text Search] Error in Places API search:', error);
      return {
        success: false,
        error: `Failed to search venues using Google Places Text Search: ${error instanceof Error ? error.message : String(error)}`
      };
    }
  }

  /**
   * Busca venues usando Google Places API - Nearby Search (funciona con nuestra API key)
   */
  private async searchVenuesWithPlaces(
    searchTerm: string,
    city: string,
    region: string,
    limit: number = 1,
    excludeVenues?: { placeIds?: string[]; names?: string[] },
    country?: string
  ): Promise<VenueSearchResult> {
    try {
      // Normalizar el searchTerm (solo limpieza básica)
      const cleanSearchTerm = this.cleanSearchTerm(searchTerm);
      
      console.log(`🔍 Starting Places API search for: "${searchTerm}" in ${city}, ${region}${country ? `, ${country}` : ''}`);
      console.log(`🧹 Cleaned searchTerm: "${cleanSearchTerm}" (was: "${searchTerm}")`);
      
      // INTENTO 1: Usar Text Search (más directo, sin geocoding)
      console.log(`📝 [Method 1] Trying Text Search first (no geocoding required)...`);
      const textSearchResult = await this.searchWithTextSearch(cleanSearchTerm, city, region, country, limit, excludeVenues);
      
      if (textSearchResult.success && textSearchResult.venues && textSearchResult.venues.length > 0) {
        console.log(`✅ [Method 1] Text Search succeeded with ${textSearchResult.venues.length} venues`);
        return textSearchResult;
      }
      
      console.log(`⚠️ [Method 1] Text Search failed or no results, trying Nearby Search as fallback...`);
      
      // INTENTO 2: Fallback a Nearby Search (requiere geocoding)
      console.log(`📍 [Method 2] Trying Nearby Search (with geocoding)...`);
      
      // Obtener coordenadas de la ubicación
      const coordinates = await this.geocodeLocation(city, region, country);
      if (!coordinates) {
        const locationString = country ? `${city}, ${region}, ${country}` : `${city}, ${region}`;
        console.error(`❌ [Method 2] Could not geocode location: ${locationString}`);
        return {
          success: false,
          error: `Could not find coordinates for ${locationString}. Both Text Search and Geocoding failed. Please check if the location is valid.`
        };
      }

      // Usar Nearby Search como fallback
      const url = `${this.placesApiUrl}/nearbysearch/json?location=${coordinates.lat},${coordinates.lng}&radius=10000&type=establishment&keyword=${encodeURIComponent(cleanSearchTerm)}&key=${this.googleApiKey}`;
      
      console.log(`🚀 [Method 2] Places API Nearby Search request for: "${cleanSearchTerm}" near ${coordinates.lat},${coordinates.lng}`);
      console.log(`📍 [Method 2] EXACT MAPS SEARCH URL: ${url.replace(this.googleApiKey || '', '[API_KEY_HIDDEN]')}`);
      
      const response = await fetch(url);
      
      if (!response.ok) {
        console.error('❌ [Method 2] HTTP error in Places API request:', response.status, response.statusText);
        return {
          success: false,
          error: `Google Places Nearby Search API HTTP error: ${response.status} ${response.statusText}`
        };
      }

      const data = await response.json();
      
      console.log('📊 [Method 2] Places API response status:', data.status);
      
      if (data.status === 'REQUEST_DENIED') {
        console.error('❌ Google Places API Request Denied');
        console.error('   Error message:', data.error_message);
        console.error('   Common causes:');
        console.error('   1. API key is not valid');
        console.error('   2. Places API is not enabled');
        console.error('   3. Billing is not enabled');
        console.error('   4. API key has restrictions that prevent this request');
        return {
          success: false,
          error: `Google Places API access denied: ${data.error_message || 'Check API key configuration and permissions'}`
        };
      }
      
      if (data.status === 'OVER_QUERY_LIMIT') {
        console.error('❌ Google Places API quota exceeded');
        console.error('   Error message:', data.error_message);
        return {
          success: false,
          error: `Google Places API quota exceeded: ${data.error_message || 'Check billing and quota limits'}`
        };
      }

      if (data.status !== 'OK' && data.status !== 'ZERO_RESULTS') {
        console.error('❌ Google Places API returned unexpected status:', data.status);
        console.error('   Error message:', data.error_message);
        return {
          success: false,
          error: `Google Places API error: ${data.status} - ${data.error_message || 'Unknown error'}`
        };
      }

      if (!data.results || data.results.length === 0) {
        console.log('ℹ️ No venues found for the search criteria');
        return {
          success: true,
          venues: []
        };
      }

      console.log(`✅ Found ${data.results.length} venues from Places API`);

      // Filtrar venues excluidos antes de procesar
      let filteredResults = data.results;
      
      if (excludeVenues) {
        const originalCount = filteredResults.length;
        
        console.log(`🚫 Processing exclusions for ${originalCount} venues:`, {
          excludePlaceIds: excludeVenues.placeIds || [],
          excludeNames: excludeVenues.names || []
        });
        
        // Filtrar por Place IDs
        if (excludeVenues.placeIds && excludeVenues.placeIds.length > 0) {
          filteredResults = filteredResults.filter((place: any) => 
            !excludeVenues.placeIds!.includes(place.place_id)
          );
        }
        
        // Filtrar por nombres (case-insensitive)
        if (excludeVenues.names && excludeVenues.names.length > 0) {
          const excludeNamesLower = excludeVenues.names.map(name => name.toLowerCase().trim());
          console.log(`🚫 Names to exclude (normalized):`, excludeNamesLower);
          
          filteredResults = filteredResults.filter((place: any) => {
            const placeName = place.name?.toLowerCase().trim();
            const shouldExclude = excludeNamesLower.includes(placeName);
            if (shouldExclude) {
              console.log(`🚫 EXCLUDING venue: "${place.name}" (normalized: "${placeName}")`);
            }
            return !shouldExclude;
          });
        }
        
        const excludedCount = originalCount - filteredResults.length;
        if (excludedCount > 0) {
          console.log(`🚫 Excluded ${excludedCount} venues based on exclusion criteria`);
        }
      }

      // Convertir resultados de Google Places a nuestro formato
      const venues = await Promise.all(
        filteredResults
          .slice(0, limit)
          .map(async (place: any) => await this.mapGooglePlaceToVenue(place))
      );

      const validVenues = venues.filter(venue => venue !== null);
      console.log(`✅ [Method 2] Nearby Search succeeded with ${validVenues.length} venues`);

      return {
        success: true,
        venues: validVenues
      };
    } catch (error) {
      console.error('❌ Error in Places API search:', error);
      return {
        success: false,
        error: `Failed to search venues using Google Places API: ${error instanceof Error ? error.message : String(error)}`
      };
    }
  }

  /**
   * Obtiene detalles adicionales de un lugar usando Place Details API
   */
  private async getPlaceDetails(placeId: string): Promise<any> {
    try {
      // Pedir más campos para obtener máxima información de contacto y detalles
      const fields = [
        'formatted_phone_number',
        'international_phone_number',
        'website',
        'url',
        'business_status',
        'opening_hours',
        'rating',
        'user_ratings_total',
        'types',
        'formatted_address',
        'vicinity',
        'price_level',
        'reviews',
        'photos'
      ].join(',');
      
      const url = `${this.placesApiUrl}/details/json?place_id=${placeId}&fields=${fields}&key=${this.googleApiKey}`;
      
      const response = await fetch(url);
      
      if (!response.ok) {
        console.error('Error getting place details:', response.statusText);
        return null;
      }

      const data = await response.json();
      
      if (data.status !== 'OK') {
        console.error('Place Details API returned status:', data.status);
        return null;
      }

      return data.result;
    } catch (error) {
      console.error('Error getting place details:', error);
      return null;
    }
  }

  /**
   * Convierte un resultado de Google Places a nuestro formato de venue
   */
  private async mapGooglePlaceToVenue(place: any): Promise<Venue | null> {
    try {
      // Obtener detalles adicionales del lugar
      const details = place.place_id ? await this.getPlaceDetails(place.place_id) : null;
      
      return {
        id: place.place_id || `venue_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        name: place.name || 'Unknown',
        address: details?.formatted_address || place.formatted_address || details?.vicinity || 'Address not available',
        phone: details?.formatted_phone_number || 'Not available',
        international_phone: details?.international_phone_number,
        website: details?.website || 'Not available',
        google_maps_url: details?.url,
        business_status: details?.business_status || 'UNKNOWN',
        rating: details?.rating ? details.rating.toString() : place.rating ? place.rating.toString() : 'Not rated',
        total_ratings: details?.user_ratings_total,
        price_level: details?.price_level,
        types: details?.types || place.types || [],
        location: {
          lat: place.geometry?.location?.lat || 0,
          lng: place.geometry?.location?.lng || 0
        },
        opening_hours: {
          open_now: details?.opening_hours?.open_now || place.opening_hours?.open_now || false,
          periods: details?.opening_hours?.periods,
          weekday_text: details?.opening_hours?.weekday_text
        },
        amenities: this.extractAmenitiesFromTypes(details?.types || place.types || []),
        description: this.buildDescriptionFromPlace(place, details),
        reviews: details?.reviews ? details.reviews.slice(0, 3).map((review: any) => ({
          author_name: review.author_name,
          rating: review.rating,
          text: review.text,
          time: review.time
        })) : undefined,
        photos: details?.photos ? details.photos.slice(0, 3).map((photo: any) => ({
          photo_reference: photo.photo_reference,
          width: photo.width,
          height: photo.height
        })) : undefined
      };
    } catch (error) {
      console.error('Error mapping Google Place to venue:', error);
      return null;
    }
  }

  /**
   * Extrae amenidades de los tipos de lugar de Google
   */
  private extractAmenitiesFromTypes(types: string[]): string[] {
    const amenityMap: { [key: string]: string } = {
      'restaurant': 'Food & Dining',
      'food': 'Food & Dining',
      'meal_takeaway': 'Takeaway',
      'parking': 'Parking Available',
      'wheelchair_accessible_entrance': 'Wheelchair Accessible',
      'wifi': 'Free WiFi',
      'accepts_credit_cards': 'Credit Cards Accepted',
      'outdoor_seating': 'Outdoor Seating',
      'delivery': 'Delivery Available',
      'reservations': 'Reservations',
      'good_for_groups': 'Good for Groups',
      'kids_friendly': 'Kid Friendly',
      'pet_friendly': 'Pet Friendly'
    };

    return types
      .map(type => amenityMap[type] || type.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase()))
      .filter(amenity => amenity !== '');
  }

  /**
   * Construye una descripción del lugar basada en los datos disponibles
   */
  private buildDescriptionFromPlace(place: any, details: any): string {
    const parts = [];
    
    // Rating y número de reseñas
    if (details?.rating) {
      const ratingText = `Rated ${details.rating}/5 stars`;
      if (details?.user_ratings_total) {
        parts.push(`${ratingText} (${details.user_ratings_total} reviews)`);
      } else {
        parts.push(ratingText);
      }
    }
    
    // Tipo principal del negocio
    if (details?.types && details.types.length > 0) {
      const mainType = details.types[0].replace(/_/g, ' ').replace(/\b\w/g, (l: string) => l.toUpperCase());
      parts.push(`Type: ${mainType}`);
    }
    
    // Estado del negocio
    if (details?.business_status) {
      const statusMap: { [key: string]: string } = {
        'OPERATIONAL': 'Open for business',
        'CLOSED_TEMPORARILY': 'Temporarily closed',
        'CLOSED_PERMANENTLY': 'Permanently closed'
      };
      const status = statusMap[details.business_status] || details.business_status;
      parts.push(status);
    }
    
    // Estado actual de apertura
    if (details?.opening_hours?.open_now !== undefined) {
      parts.push(details.opening_hours.open_now ? 'Currently Open' : 'Currently Closed');
    }
    
    // Nivel de precios
    if (details?.price_level !== undefined) {
      const priceText = '$'.repeat(details.price_level + 1);
      parts.push(`Price level: ${priceText}`);
    }
    
    // Información de contacto disponible
    const contactInfo = [];
    if (details?.formatted_phone_number) contactInfo.push('Phone available');
    if (details?.website) contactInfo.push('Website available');
    if (contactInfo.length > 0) {
      parts.push(`Contact: ${contactInfo.join(', ')}`);
    }
    
    return parts.join(' • ') || 'No additional information available';
  }

  /**
   * Método principal de búsqueda de venues
   */
  async searchVenues(
    searchTerm: string,
    city: string,
    region: string,
    limit: number = 1,
    excludeVenues?: { placeIds?: string[]; names?: string[] },
    country?: string
  ): Promise<VenueSearchResult> {
    try {
      console.log(`Searching venues: "${searchTerm}" in ${city}, ${region}${country ? `, ${country}` : ''}`);
      
      // Usar Google Places API
      const result = await this.searchVenuesWithPlaces(searchTerm, city, region, limit, excludeVenues, country);
      
      if (result.success) {
        console.log(`Found ${result.venues?.length || 0} venues`);
      }
      
      return result;
    } catch (error) {
      console.error('Error in searchVenues:', error);
      return {
        success: false,
        error: 'Failed to search venues'
      };
    }
  }



  /**
   * Busca venues en una región (método principal del servicio)
   */
  async searchRegionVenues(params: VenueSearchParams): Promise<VenueSearchResult> {
    try {
      // Validar parámetros
      const validation = this.validateSearchParams(params);
      if (!validation.valid) {
        return {
          success: false,
          error: validation.error
        };
      }

      const finalLimit = params.limit || 1;

      // Limpiar memorias expiradas periódicamente
      await this.cleanupExpiredMemories(params.siteId);

      // Verificar si esta búsqueda ya está marcada como sin resultados
      const isMarkedAsNoResults = await this.isSearchMarkedAsNoResults(
        params.siteId,
        params.searchTerm,
        params.city,
        params.region
      );

      if (isMarkedAsNoResults) {
        console.log(`🧠 Search already marked as no-results in memory, skipping API call`);
        return {
          success: true,
          venues: []
        };
      }

      // Consultar memorias del sistema para obtener venues que no dieron resultados
      const failedVenuesFromMemory = await this.getFailedVenuesFromMemory(
        params.siteId,
        params.searchTerm,
        params.city,
        params.region
      );

      // Combinar venues excluidos con los de la memoria
      const combinedExcludeVenues = {
        placeIds: [
          ...(params.excludeVenues?.placeIds || []),
        ],
        names: [
          ...(params.excludeVenues?.names || []),
          ...failedVenuesFromMemory
        ]
      };

      console.log(`🧠 Total venues to exclude: ${combinedExcludeVenues.names.length} by name, ${combinedExcludeVenues.placeIds.length} by place ID`);

      // Buscar venues
      const searchResult = await this.searchVenues(
        params.searchTerm,
        params.city,
        params.region,
        finalLimit,
        combinedExcludeVenues,
        params.country
      );

      if (!searchResult.success) {
        return searchResult;
      }

      // Si no encontramos venues, guardar en memoria para futuras búsquedas
      if (searchResult.venues && searchResult.venues.length === 0) {
        console.log(`🧠 No venues found for search, saving to memory for future optimization`);
        await this.saveNoResultsToMemory(
          params.siteId,
          params.searchTerm,
          params.city,
          params.region
        );
      }

      return searchResult;
    } catch (error) {
      console.error('Error in searchRegionVenues:', error);
      return {
        success: false,
        error: 'Failed to search venues in region'
      };
    }
  }
} 