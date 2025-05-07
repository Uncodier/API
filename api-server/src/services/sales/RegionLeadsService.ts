import { supabaseAdmin } from '@/lib/database/supabase-client';
import { v4 as uuidv4 } from 'uuid';
import { 
  Client, 
  Language,
  PlaceType1
} from '@googlemaps/google-maps-services-js';

// Interfaces para la búsqueda de negocios
export interface Business {
  id: string;
  name: string;
  address: string;
  phone: string;
  website: string;
  rating: string;
  types: string[];
  location: {
    lat: number;
    lng: number;
  };
  opening_hours: {
    open_now: boolean;
  };
}

export interface SearchResult {
  success: boolean;
  businesses?: Business[];
  error?: string;
}

export interface DbSaveResult {
  success: boolean;
  searchId?: string;
  businessCount?: number;
}

export interface SearchParams {
  siteId: string;
  userId?: string;
  region: string;
  businessType?: string;
  keywords?: string[];
  limit?: number;
}

// Inicializa el cliente de Google Maps Places API
const googleMapsClient = new Client({});

/**
 * Servicio para buscar negocios en una región y generar leads
 */
export class RegionLeadsService {
  /**
   * Valida los parámetros de búsqueda
   */
  validateSearchParams(params: SearchParams): { valid: boolean; error?: string } {
    // Verificar campos obligatorios
    if (!params.region) {
      return { valid: false, error: 'Region is required' };
    }
    
    if (!params.siteId) {
      return { valid: false, error: 'siteId is required' };
    }
    
    if (!params.businessType && (!params.keywords || params.keywords.length === 0)) {
      return { valid: false, error: 'Either businessType or keywords must be provided' };
    }
    
    return { valid: true };
  }

  /**
   * Busca negocios en una región específica
   */
  async searchBusinesses(
    region: string, 
    businessType: string = '', 
    keywords: string[] = [], 
    limit: number = 10
  ): Promise<SearchResult> {
    try {
      // Verificar que tenemos la clave API de Google
      const apiKey = process.env.GOOGLE_CLOUD_API_KEY;
      if (!apiKey) {
        console.error('GOOGLE_CLOUD_API_KEY is not set in environment variables');
        return {
          success: false,
          error: 'Google API key is missing'
        };
      }

      console.log(`🔍 Searching for businesses in ${region} of type: ${businessType} with keywords: ${keywords.join(', ')}`);
      
      // Construir la consulta para Google Places
      let query = businessType || '';
      if (keywords && keywords.length > 0) {
        if (query) query += ' ';
        query += keywords.join(' ');
      }
      
      // Si la consulta sigue vacía, usar un valor por defecto
      if (!query.trim()) {
        query = 'business';
      }
      
      // Realizamos la búsqueda utilizando los tipos correctos
      try {
        // Realizar la búsqueda de texto en Google Places
        const searchResponse = await googleMapsClient.textSearch({
          params: {
            query: `${query} in ${region}`,
            key: apiKey,
          },
          timeout: 10000, // 10 segundos de timeout
        });
        
        if (searchResponse.status !== 200) {
          console.error('Error from Google Places API:', searchResponse.statusText);
          return {
            success: false,
            error: `Google Places API error: ${searchResponse.statusText}`
          };
        }
        
        const places = searchResponse.data.results || [];
        
        // Si no hay resultados, intentar una búsqueda cercana
        if (places.length === 0) {
          console.log('No results found with text search, trying nearby search...');
          
          // Para nearby search necesitamos coordenadas, así que primero geocodificamos la región
          const geocodeResponse = await googleMapsClient.geocode({
            params: {
              address: region,
              key: apiKey,
            }
          });
          
          if (geocodeResponse.status !== 200 || !geocodeResponse.data.results[0]) {
            console.error('Error geocoding region:', region);
            return {
              success: false,
              error: 'Could not find location for the specified region'
            };
          }
          
          const location = geocodeResponse.data.results[0].geometry.location;
          
          // Ahora hacemos la búsqueda cercana
          const nearbyResponse = await googleMapsClient.placesNearby({
            params: {
              location: location,
              radius: 50000, // 50km radio
              keyword: keywords.join(' ') || undefined,
              key: apiKey,
            }
          });
          
          if (nearbyResponse.status !== 200) {
            console.error('Error from Google Places Nearby API:', nearbyResponse.statusText);
            return {
              success: false,
              error: `Google Places API error: ${nearbyResponse.statusText}`
            };
          }
          
          // Usar los resultados de nearby search
          return {
            success: true,
            businesses: nearbyResponse.data.results.slice(0, limit).map(place => this.mapGooglePlaceToBusinessModel(place))
          };
        }
        
        // Convertir los resultados de Google Places a nuestro formato de negocio
        const businesses = places.slice(0, limit).map(place => this.mapGooglePlaceToBusinessModel(place));
        
        return {
          success: true,
          businesses
        };
      } catch (error) {
        console.error('Error en la búsqueda de Google Places:', error);
        return {
          success: false,
          error: 'Error en la búsqueda de Google Places'
        };
      }
    } catch (error) {
      console.error('Error searching businesses:', error);
      return {
        success: false,
        error: 'Failed to search businesses'
      };
    }
  }

  /**
   * Convierte un lugar de Google a nuestro modelo de negocio
   */
  private mapGooglePlaceToBusinessModel(place: any): Business {
    return {
      id: place.place_id || `place_${uuidv4().substring(0, 8)}`,
      name: place.name || 'Unknown Business',
      address: place.formatted_address || place.vicinity || 'No address available',
      phone: place.formatted_phone_number || place.international_phone_number || '',
      website: place.website || '',
      rating: place.rating ? place.rating.toString() : '0',
      types: place.types || [],
      location: {
        lat: place.geometry?.location?.lat || 0,
        lng: place.geometry?.location?.lng || 0
      },
      opening_hours: {
        open_now: place.opening_hours?.open_now || false
      }
    };
  }

  /**
   * Guarda los resultados de búsqueda en la base de datos
   */
  async saveSearchResults(siteId: string, userId: string, region: string, businesses: Business[]): Promise<DbSaveResult> {
    try {
      const searchRecord = {
        id: uuidv4(),
        site_id: siteId,
        user_id: userId,
        region: region,
        search_timestamp: new Date().toISOString(),
        results_count: businesses.length,
        status: 'completed'
      };
      
      // Insert the search record
      const { data: searchData, error: searchError } = await supabaseAdmin
        .from('business_searches')
        .insert([searchRecord])
        .select('id')
        .single();
      
      if (searchError) {
        console.error('Error storing search record:', searchError);
        return { success: false };
      }
      
      // Insert the business results
      const businessRecords = businesses.map(business => ({
        id: uuidv4(),
        search_id: searchData.id,
        business_name: business.name,
        address: business.address,
        phone: business.phone,
        website: business.website,
        rating: business.rating,
        business_type: business.types && business.types.length > 0 ? business.types[0] : '',
        lat: business.location.lat,
        lng: business.location.lng,
        external_id: business.id,
        contacted: false,
        contact_status: 'pending'
      }));
      
      const { error: businessError } = await supabaseAdmin
        .from('business_leads')
        .insert(businessRecords);
      
      if (businessError) {
        console.error('Error storing business leads:', businessError);
        return { success: false };
      }
      
      return { 
        success: true, 
        searchId: searchData.id,
        businessCount: businesses.length
      };
    } catch (error) {
      console.error('Error saving search results:', error);
      return { success: false };
    }
  }

  /**
   * Realiza una búsqueda completa de negocios en una región
   */
  async searchRegionBusinesses(params: SearchParams): Promise<SearchResult> {
    try {
      // Validar parámetros
      const validation = this.validateSearchParams(params);
      if (!validation.valid) {
        return {
          success: false,
          error: validation.error
        };
      }

      // Extraer parámetros
      const { 
        region, 
        businessType = '', 
        keywords = [], 
        limit = 10 
      } = params;

      // Buscar negocios
      const searchResult = await this.searchBusinesses(region, businessType, keywords, limit);

      // Guardar resultados en base de datos si se proporcionó userId
      if (searchResult.success && searchResult.businesses && params.userId) {
        await this.saveSearchResults(params.siteId, params.userId, region, searchResult.businesses);
      }

      return searchResult;
    } catch (error) {
      console.error('Error in searchRegionBusinesses:', error);
      return {
        success: false,
        error: 'Failed to search region businesses'
      };
    }
  }
} 