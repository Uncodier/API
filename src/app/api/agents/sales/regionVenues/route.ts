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
    const businessTypes = url.searchParams.get('businessTypes'); // Para debug
    const city = url.searchParams.get('city');
    const region = url.searchParams.get('region');
    const country = url.searchParams.get('country');
    const maxVenuesParam = url.searchParams.get('maxVenues');
    const maxVenues = parseInt(maxVenuesParam || '1');
    
    // 🔍 LOGS DETALLADOS DE LA URL Y PARÁMETROS
    console.log('🔍 [GET] URL COMPLETA:', request.url);
    console.log('🔍 [GET] PARÁMETROS INDIVIDUALES:');
    console.log('   - siteId:', JSON.stringify(siteId), '(present:', !!siteId, ')');
    console.log('   - searchTerm:', JSON.stringify(searchTerm), '(present:', !!searchTerm, ')');
    console.log('   - businessTypes:', JSON.stringify(businessTypes), '(present:', !!businessTypes, ')');
    console.log('   - city:', JSON.stringify(city), '(present:', !!city, ')');
    console.log('   - region:', JSON.stringify(region), '(present:', !!region, ')');
    console.log('   - country:', JSON.stringify(country), '(present:', !!country, ')');
    console.log('   - maxVenues:', JSON.stringify(maxVenues), '(from:', JSON.stringify(maxVenuesParam), ')');
    
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
    if (maxVenues < 1 || maxVenues > 60) {
      return NextResponse.json(
        { 
          success: false, 
          error: { 
            code: 'INVALID_REQUEST', 
            message: 'maxVenues must be between 1 and 60' 
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
    // Obtener parámetros del cuerpo
    const params = await request.json();
    
    // 🔍 LOGS DETALLADOS DEL BODY COMPLETO
    console.log('🔍 [POST] BODY COMPLETO RECIBIDO:', JSON.stringify(params, null, 2));
    console.log('🔍 [POST] KEYS DEL BODY:', Object.keys(params));
    console.log('🔍 [POST] PARÁMETROS INDIVIDUALES:');
    console.log('   - siteId:', JSON.stringify(params.siteId), '(type:', typeof params.siteId, ')');
    console.log('   - searchTerm:', JSON.stringify(params.searchTerm), '(type:', typeof params.searchTerm, ')');
    console.log('   - businessTypes:', JSON.stringify(params.businessTypes), '(type:', typeof params.businessTypes, ')');
    console.log('   - city:', JSON.stringify(params.city), '(type:', typeof params.city, ')');
    console.log('   - region:', JSON.stringify(params.region), '(type:', typeof params.region, ')');
    console.log('   - country:', JSON.stringify(params.country), '(type:', typeof params.country, ')');
    console.log('   - maxVenues:', JSON.stringify(params.maxVenues), '(type:', typeof params.maxVenues, ')');
    console.log('   - userId:', JSON.stringify(params.userId), '(type:', typeof params.userId, ')');
    
    // Validar parámetros requeridos
    console.log('🔍 [POST] VALIDACIÓN DE PARÁMETROS REQUERIDOS:');
    console.log('   - siteId check:', !!params.siteId, '| value:', JSON.stringify(params.siteId), '| length:', params.siteId?.length);
    console.log('   - searchTerm check:', !!params.searchTerm, '| value:', JSON.stringify(params.searchTerm), '| length:', params.searchTerm?.length);
    console.log('   - city check:', !!params.city, '| value:', JSON.stringify(params.city), '| length:', params.city?.length);
    console.log('   - region check:', !!params.region, '| value:', JSON.stringify(params.region), '| length:', params.region?.length);
    
    const validationFails = !params.siteId || !params.searchTerm || !params.city || !params.region;
    console.log('🔍 [POST] VALIDATION RESULT:', {
      validationFails,
      individual_checks: {
        siteId_fail: !params.siteId,
        searchTerm_fail: !params.searchTerm,
        city_fail: !params.city,
        region_fail: !params.region
      }
    });
    
    if (validationFails) {
      console.error('❌ [POST] VALIDATION FAILED - Missing required parameters:', {
        siteId: !!params.siteId,
        searchTerm: !!params.searchTerm,
        city: !!params.city,
        region: !!params.region,
        siteId_value: params.siteId,
        searchTerm_value: params.searchTerm,
        city_value: params.city,
        region_value: params.region
      });
      
      return NextResponse.json(
        { 
          success: false, 
          error: { 
            code: 'INVALID_REQUEST', 
            message: 'siteId, searchTerm, city, and region are required' 
          } 
        },
        { status: 400 }
      );
    }
    
    console.log('✅ [POST] Validation passed - all required parameters present');
    
    // Validar maxVenues
    const maxVenues = params.maxVenues || 1;
    console.log('🔍 [POST] VALIDACIÓN DE maxVenues:');
    console.log('   - maxVenues value:', maxVenues, '| type:', typeof maxVenues);
    console.log('   - original params.maxVenues:', params.maxVenues, '| type:', typeof params.maxVenues);
    console.log('   - check < 1:', maxVenues < 1);
    console.log('   - check > 60:', maxVenues > 60);
    console.log('   - validation fails:', maxVenues < 1 || maxVenues > 60);
    
    if (maxVenues < 1 || maxVenues > 60) {
      console.error('❌ [POST] maxVenues validation failed:', {
        maxVenues,
        original: params.maxVenues,
        lessThan1: maxVenues < 1,
        greaterThan60: maxVenues > 60
      });
      
      return NextResponse.json(
        { 
          success: false, 
          error: { 
            code: 'INVALID_REQUEST', 
            message: 'maxVenues must be between 1 and 60' 
          } 
        },
        { status: 400 }
      );
    }
    
    console.log('✅ [POST] maxVenues validation passed:', maxVenues);
    
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
    const searchResult = await regionVenuesService.searchRegionVenues({
      siteId: params.siteId,
      userId: params.userId,
      searchTerm: params.searchTerm,
      city: params.city,
      region: params.region,
      country: params.country,
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
        searchTerm: params.searchTerm,
        city: params.city,
        region: params.region,
        country: params.country,
        venueCount: limitedVenues.length,
        venues: limitedVenues,
        // Incluir datos adicionales si se proporcionaron
        ...(params.targetAudience && { targetAudience: params.targetAudience }),
        ...(params.eventInfo && { eventInfo: params.eventInfo }),
        ...(params.contactPreferences && { contactPreferences: params.contactPreferences }),
        timestamp: new Date().toISOString()
      }
    });
    
  } catch (error) {
    console.error('General error in region venues POST route:', error);
    
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