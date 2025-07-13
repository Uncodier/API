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
    const maxVenuesParam = url.searchParams.get('maxVenues');
    const maxVenues = parseInt(maxVenuesParam || '1');
    
    
    console.log('🔍 Region Venues API - GET request:', {
      siteId,
      searchTerm,
      city,
      region,
      maxVenues
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
      limit: maxVenues
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
    
    // Validar parámetros requeridos
    if (!params.siteId || !params.searchTerm || !params.city || !params.region) {
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
    
    // Validar maxVenues
    const maxVenues = params.maxVenues || 1;
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
    const searchResult = await regionVenuesService.searchRegionVenues({
      siteId: params.siteId,
      userId: params.userId,
      searchTerm: params.searchTerm,
      city: params.city,
      region: params.region,
      limit: maxVenues
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