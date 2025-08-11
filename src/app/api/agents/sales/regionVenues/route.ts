import { NextResponse } from 'next/server';
import { RegionVenuesService } from '@/services/sales/RegionVenuesService';

// Instancia del servicio de búsqueda de venues regionales
const regionVenuesService = new RegionVenuesService();

export async function GET(request: Request) {
  try {
    // Obtener parámetros de consulta
    const url = new URL(request.url);
    const siteId = url.searchParams.get('siteId');
    const searchTerm = url.searchParams.get('searchTerm');
    const city = url.searchParams.get('city');
    const region = url.searchParams.get('region');
    const country = url.searchParams.get('country');
    const maxVenuesParam = url.searchParams.get('maxVenues');
    const maxVenues = parseInt(maxVenuesParam || '1');
    
    // Parámetros de exclusión
    const excludePlaceIds = url.searchParams.get('excludePlaceIds');
    const excludeNames = url.searchParams.get('excludeNames');
    
    // Procesar parámetros de exclusión
    const excludeVenues = {
      placeIds: excludePlaceIds ? excludePlaceIds.split(',').map(id => id.trim()).filter(id => id) : undefined,
      names: excludeNames ? excludeNames.split(',').map(name => name.trim()).filter(name => name) : undefined
    };
    
    
    console.log('🔍 Region Venues API - GET request:', {
      siteId,
      searchTerm,
      city,
      region,
      country,
      maxVenues,
      excludeVenues: {
        placeIds: excludeVenues.placeIds?.length || 0,
        names: excludeVenues.names?.length || 0
      }
    });
    
    console.log('🔍 EXACT PARAMETERS RECEIVED:', {
      searchTerm_exact: JSON.stringify(searchTerm),
      city_exact: JSON.stringify(city),
      region_exact: JSON.stringify(region),
      country_exact: JSON.stringify(country),
      searchTerm_length: searchTerm?.length,
      contains_location_in_searchTerm: searchTerm?.includes('in ') || searchTerm?.includes('en '),
      full_url: request.url
    });
    
    // Validar parámetros requeridos
    if (!siteId || !searchTerm || !city || !region) {
      console.error('❌ Missing required parameters:', {
        siteId: !!siteId,
        searchTerm: !!searchTerm,
        city: !!city,
        region: !!region
      });
      
      return NextResponse.json(
        { 
          success: false, 
          error: { 
            code: 'INVALID_REQUEST', 
            message: 'siteId, searchTerm, city, and region parameters are required' 
          } 
        },
        { status: 400 }
      );
    }
    
    // Validar maxVenues
    if (maxVenues < 1 || maxVenues > 50) {
      return NextResponse.json(
        { 
          success: false, 
          error: { 
            code: 'INVALID_REQUEST', 
            message: 'maxVenues must be between 1 and 50' 
          } 
        },
        { status: 400 }
      );
    }
    
    // Buscar venues en la región
    console.log('🚀 Starting venue search with Google Maps API...');
    
    const searchResult = await regionVenuesService.searchRegionVenues({
      siteId,
      searchTerm,
      city,
      region,
      country: country || undefined,
      limit: maxVenues,
      excludeVenues: (excludeVenues.placeIds || excludeVenues.names) ? excludeVenues : undefined
    });
    
    console.log('📊 Search result:', {
      success: searchResult.success,
      venueCount: searchResult.venues?.length || 0,
      hasError: !!searchResult.error
    });
    
    if (!searchResult.success) {
      console.error('❌ Venue search failed:', searchResult.error);
      return NextResponse.json(
        { 
          success: false, 
          error: { 
            code: 'SEARCH_FAILED', 
            message: searchResult.error || 'Failed to search venues' 
          } 
        },
        { status: 500 }
      );
    }
    
    // Limitar venues a la cantidad solicitada (verificación adicional)
    const limitedVenues = searchResult.venues?.slice(0, maxVenues) || [];
    
    // Devolver resultados directamente
    const response = {
      success: true,
      data: {
        searchTerm,
        city,
        region,
        country,
        venueCount: limitedVenues.length,
        venues: limitedVenues,
        timestamp: new Date().toISOString()
      }
    };
    
    console.log('✅ Returning successful response with', response.data.venueCount, 'venues');
    return NextResponse.json(response);
    
  } catch (error) {
    console.error('💥 General error in region venues route:', error);
    
    return NextResponse.json(
      { 
        success: false, 
        error: { 
          code: 'SYSTEM_ERROR', 
          message: 'An internal system error occurred' 
        } 
      },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  try {
    console.log('📥 POST request received - parsing body...');
    
    // Verificar Content-Type
    const contentType = request.headers.get('content-type');
    console.log('📋 Content-Type:', contentType);
    
    // Obtener parámetros del cuerpo
    let params;
    try {
      params = await request.json();
      console.log('✅ JSON parsed successfully:', Object.keys(params));
    } catch (jsonError) {
      console.error('❌ JSON parsing failed:', jsonError);
      return NextResponse.json(
        { 
          success: false, 
          error: { 
            code: 'INVALID_JSON', 
            message: 'Invalid JSON format in request body',
            details: jsonError instanceof Error ? jsonError.message : 'Unknown JSON error'
          } 
        },
        { status: 400 }
      );
    }

    // Normalizar parámetros - soportar tanto snake_case como camelCase
    const siteId = params.siteId || params.site_id;
    const userId = params.userId || params.user_id;
    const city = params.city;
    const region = params.region;
    const country = params.country;
    
    // Generar searchTerm automáticamente si no se proporciona
    let searchTerm = params.searchTerm || params.search_term;
    if (!searchTerm && params.businessTypes && Array.isArray(params.businessTypes)) {
      // Extraer los nombres de los business types para crear el searchTerm
      const businessNames = params.businessTypes.map((bt: any) => bt.name).join(', ');
      searchTerm = businessNames;
      console.log('🔄 Generated searchTerm from businessTypes:', searchTerm);
    }
    
    console.log('🔍 Normalized parameters:', {
      siteId,
      userId,
      searchTerm,
      city,
      region,
      country,
      businessTypesCount: params.businessTypes?.length || 0
    });
    
    // Validar parámetros requeridos
    if (!siteId || !searchTerm || !city || !region) {
      console.error('❌ Missing required parameters:', {
        siteId: !!siteId,
        searchTerm: !!searchTerm,
        city: !!city,
        region: !!region
      });
      
      return NextResponse.json(
        { 
          success: false, 
          error: { 
            code: 'INVALID_REQUEST', 
            message: 'siteId (or site_id), searchTerm (or business types), city, and region are required' 
          } 
        },
        { status: 400 }
      );
    }
    
    // Validar maxVenues
    const maxVenues = params.maxVenues || params.max_venues || 1;
    if (maxVenues < 1 || maxVenues > 50) {
      return NextResponse.json(
        { 
          success: false, 
          error: { 
            code: 'INVALID_REQUEST', 
            message: 'maxVenues must be between 1 and 50' 
          } 
        },
        { status: 400 }
      );
    }
    
    // Procesar parámetros de exclusión del body
    const excludeVenues = params.excludeVenues || {};
    
    // También procesar excludeNames y excludePlaceIds del nivel raíz (como en GET)
    if (params.excludeNames && Array.isArray(params.excludeNames)) {
      excludeVenues.names = params.excludeNames.filter((name: string) => name && name.trim());
    }
    if (params.excludePlaceIds && Array.isArray(params.excludePlaceIds)) {
      excludeVenues.placeIds = params.excludePlaceIds.filter((id: string) => id && id.trim());
    }
    
    console.log('🚫 POST - Exclusion parameters processed:', {
      excludeVenuesFromParam: Object.keys(params.excludeVenues || {}).length > 0,
      excludeNamesCount: excludeVenues.names?.length || 0,
      excludePlaceIdsCount: excludeVenues.placeIds?.length || 0,
      excludeNames: excludeVenues.names
    });
    
    // Buscar venues en la región
    console.log('🚀 Starting venue search with Google Maps API...');
    
    const searchResult = await regionVenuesService.searchRegionVenues({
      siteId,
      userId,
      searchTerm,
      city,
      region,
      country,
      limit: maxVenues,
      excludeVenues: (excludeVenues.placeIds || excludeVenues.names) ? excludeVenues : undefined
    });
    
    if (!searchResult.success) {
      return NextResponse.json(
        { 
          success: false, 
          error: { 
            code: 'SEARCH_FAILED', 
            message: searchResult.error || 'Failed to search venues' 
          } 
        },
        { status: 500 }
      );
    }
    
    // Limitar venues a la cantidad solicitada (verificación adicional)
    const limitedVenues = searchResult.venues?.slice(0, maxVenues) || [];
    
    // Devolver resultados directamente (igual que GET pero con más datos opcionales)
    return NextResponse.json({
      success: true,
      data: {
        searchTerm,
        city,
        region,
        country,
        venueCount: limitedVenues.length,
        venues: limitedVenues,
        // Incluir datos adicionales si se proporcionaron
        ...(params.targetAudience && { targetAudience: params.targetAudience }),
        ...(params.eventInfo && { eventInfo: params.eventInfo }),
        ...(params.contactPreferences && { contactPreferences: params.contactPreferences }),
        ...(params.businessTypes && { businessTypes: params.businessTypes }),
        timestamp: new Date().toISOString()
      }
    });
    
  } catch (error) {
    console.error('💥 General error in region venues POST route:', {
      error: error instanceof Error ? error.message : error,
      stack: error instanceof Error ? error.stack : undefined,
      type: typeof error,
      name: error instanceof Error ? error.name : undefined
    });
    
    return NextResponse.json(
      { 
        success: false, 
        error: { 
          code: 'SYSTEM_ERROR', 
          message: 'An internal system error occurred',
          ...(process.env.NODE_ENV === 'development' && {
            details: error instanceof Error ? error.message : String(error)
          })
        } 
      },
      { status: 500 }
    );
  }
} 