import { supabaseAdmin } from '@/lib/database/supabase-client';
import { v4 as uuidv4 } from 'uuid';
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

export interface DbSaveResult {
  success: boolean;
  searchId?: string;
  venueCount?: number;
}

export interface VenueSearchParams {
  siteId: string;
  userId?: string;
  searchTerm: string;
  city: string;
  region: string;
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
   */
  private async getFailedVenuesFromMemory(siteId: string, searchTerm: string, city: string, region: string): Promise<string[]> {
    try {
      // Generar clave para búsqueda por ciudad/región
      const cityKey = `${city.toLowerCase().trim()}:${region.toLowerCase().trim()}`;
      
      const memoryResult = await systemMemoryService.findMemory({
        siteId,
        systemType: 'venue_failed_names',
        key: cityKey
      });
      
      if (memoryResult.success && memoryResult.memory) {
        const excludedNames = memoryResult.memory.data.excludedNames || [];
        console.log(`🧠 Found ${excludedNames.length} venue names to exclude for ${city}, ${region}`);
        return excludedNames;
      }
      
      return [];
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
   */
  private async isSearchMarkedAsNoResults(siteId: string, searchTerm: string, city: string, region: string): Promise<boolean> {
    try {
      const memoryKey = this.generateMemoryKey(searchTerm, city, region);
      
      const memoryResult = await systemMemoryService.findMemory({
        siteId,
        systemType: 'venue_search_no_results',
        key: memoryKey
      });
      
      if (memoryResult.success && memoryResult.memory) {
        const isNoResults = memoryResult.memory.data.noResults === true;
        if (isNoResults) {
          console.log(`🧠 Search is marked as no-results in memory: ${searchTerm} in ${city}, ${region}`);
        }
        return isNoResults;
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
  private async geocodeLocation(city: string, region: string): Promise<{ lat: number; lng: number } | null> {
    try {
      const query = `${city}, ${region}`;
      const url = `${this.geocodingApiUrl}?address=${encodeURIComponent(query)}&key=${this.googleApiKey}`;
      
      console.log(`🔍 Geocoding request for: "${query}"`);
      
      const response = await fetch(url);
      
      if (!response.ok) {
        console.error('❌ HTTP error in geocoding request:', response.status, response.statusText);
        return null;
      }
      
      const data = await response.json();
      
      console.log('📊 Geocoding API response status:', data.status);
      
      if (data.status === 'REQUEST_DENIED') {
        console.error('❌ Google Geocoding API Request Denied');
        console.error('   Error message:', data.error_message);
        console.error('   Common causes:');
        console.error('   1. API key is not valid');
        console.error('   2. Geocoding API is not enabled');
        console.error('   3. Billing is not enabled');
        console.error('   4. API key has restrictions that prevent this request');
        return null;
      }
      
      if (data.status === 'OVER_QUERY_LIMIT') {
        console.error('❌ Google Geocoding API quota exceeded');
        console.error('   Error message:', data.error_message);
        return null;
      }
      
      if (data.status !== 'OK' || !data.results || data.results.length === 0) {
        console.error('❌ No results found for location:', query, 'Status:', data.status);
        if (data.error_message) {
          console.error('   Error message:', data.error_message);
        }
        return null;
      }
      
      const location = data.results[0].geometry.location;
      console.log('✅ Geocoding successful:', location);
      
      return {
        lat: location.lat,
        lng: location.lng
      };
    } catch (error) {
      console.error('❌ Error in geocoding request:', error);
      return null;
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
    excludeVenues?: { placeIds?: string[]; names?: string[] }
  ): Promise<VenueSearchResult> {
    try {
      console.log(`🔍 Starting Places API search for: "${searchTerm}" in ${city}, ${region}`);
      
      // Primero, obtener coordenadas de la ubicación
      const coordinates = await this.geocodeLocation(city, region);
      if (!coordinates) {
        return {
          success: false,
          error: `Could not find coordinates for ${city}, ${region}. Please check if the location is valid and if Google Geocoding API is properly configured.`
        };
      }

      // Usar Nearby Search en lugar de Text Search (funciona con nuestra API key)
      const url = `${this.placesApiUrl}/nearbysearch/json?location=${coordinates.lat},${coordinates.lng}&radius=10000&type=establishment&keyword=${encodeURIComponent(searchTerm)}&key=${this.googleApiKey}`;
      
      console.log(`🚀 Places API Nearby Search request for: "${searchTerm}" near ${coordinates.lat},${coordinates.lng}`);
      
      const response = await fetch(url);
      
      if (!response.ok) {
        console.error('❌ HTTP error in Places API request:', response.status, response.statusText);
        return {
          success: false,
          error: `Google Places API HTTP error: ${response.status} ${response.statusText}`
        };
      }

      const data = await response.json();
      
      console.log('📊 Places API response status:', data.status);
      
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
      console.log(`✅ Successfully processed ${validVenues.length} venues`);

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
        id: place.place_id || uuidv4(),
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
   * Busca venues (método principal)
   */
  async searchVenues(
    searchTerm: string,
    city: string,
    region: string,
    limit: number = 1,
    excludeVenues?: { placeIds?: string[]; names?: string[] }
  ): Promise<VenueSearchResult> {
    try {
      console.log(`Searching venues: "${searchTerm}" in ${city}, ${region}`);
      
      // Usar Google Places API
      const result = await this.searchVenuesWithPlaces(searchTerm, city, region, limit, excludeVenues);
      
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
   * Guarda los resultados de búsqueda en la base de datos
   */
  async saveSearchResults(siteId: string, userId: string, searchTerm: string, city: string, region: string, venues: Venue[]): Promise<DbSaveResult> {
    try {
      const searchId = uuidv4();
      
      // Guardar la búsqueda principal
      const { error: searchError } = await supabaseAdmin
        .from('region_venue_searches')
        .insert({
          id: searchId,
          site_id: siteId,
          user_id: userId,
          search_term: searchTerm,
          city: city,
          region: region,
          venue_count: venues.length,
          created_at: new Date().toISOString()
        });

      if (searchError) {
        console.error('Error saving search:', searchError);
        return {
          success: false
        };
      }

      // Guardar los venues encontrados
      if (venues.length > 0) {
        const venueRecords = venues.map(venue => ({
          id: uuidv4(),
          search_id: searchId,
          venue_id: venue.id,
          name: venue.name,
          address: venue.address,
          phone: venue.phone,
          international_phone: venue.international_phone,
          website: venue.website,
          google_maps_url: venue.google_maps_url,
          business_status: venue.business_status,
          rating: venue.rating,
          total_ratings: venue.total_ratings,
          price_level: venue.price_level,
          types: venue.types,
          location_lat: venue.location.lat,
          location_lng: venue.location.lng,
          opening_hours: venue.opening_hours,
          amenities: venue.amenities,
          description: venue.description,
          reviews: venue.reviews,
          photos: venue.photos,
          created_at: new Date().toISOString()
        }));

        const { error: venuesError } = await supabaseAdmin
          .from('region_venues')
          .insert(venueRecords);

        if (venuesError) {
          console.error('Error saving venues:', venuesError);
          return {
            success: false
          };
        }
      }

      return {
        success: true,
        searchId: searchId,
        venueCount: venues.length
      };
    } catch (error) {
      console.error('Error saving search results:', error);
      return {
        success: false
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
        combinedExcludeVenues
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

      // Guardar resultados en la base de datos si se proporcionó userId
      if (params.userId && searchResult.venues) {
        const saveResult = await this.saveSearchResults(
          params.siteId,
          params.userId,
          params.searchTerm,
          params.city,
          params.region,
          searchResult.venues
        );

        if (!saveResult.success) {
          console.warn('Failed to save search results to database');
        }
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