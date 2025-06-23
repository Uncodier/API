import { NextResponse } from 'next/server';
import { RegionLeadsService } from '@/services/sales/RegionLeadsService';

// Instancia del servicio de búsqueda regional
const regionLeadsService = new RegionLeadsService();

export async function POST(request: Request) {
  try {
    const body = await request.json();
    
    // Extraer parámetros de la solicitud
    const { 
      siteId,
      userId, 
      region,
      businessType = '',
      keywords = [],
      limit = 10
    } = body;
    
    // Llamar al servicio de búsqueda regional
    const searchResult = await regionLeadsService.searchRegionBusinesses({
      siteId,
      userId,
      region,
      businessType,
      keywords,
      limit
    });
    
    if (!searchResult.success || !searchResult.businesses) {
      return NextResponse.json(
        { success: false, error: { code: 'SEARCH_FAILED', message: searchResult.error || 'Failed to search businesses' } },
        { status: 500 }
      );
    }
    
    // Return the results
    return NextResponse.json({
      success: true,
      data: {
        region,
        total_results: searchResult.businesses.length,
        businesses: searchResult.businesses.map(business => ({
          id: business.id,
          name: business.name,
          address: business.address,
          phone: business.phone,
          website: business.website,
          rating: business.rating,
          business_type: business.types && business.types.length > 0 ? business.types[0] : '',
          location: business.location,
          open_now: business.opening_hours?.open_now
        })),
        search_id: null // ID de búsqueda se maneja internamente en el servicio
      }
    });
    
  } catch (error) {
    console.error('General error in region search route:', error);
    
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