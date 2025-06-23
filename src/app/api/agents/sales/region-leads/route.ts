import { NextResponse } from 'next/server';
import { RegionLeadsCommandService } from '@/services/sales/RegionLeadsCommandService';

// Instancia del servicio de comandos de generación de leads regionales
const regionLeadsCommandService = new RegionLeadsCommandService();

// Interfaces for our business search
interface Business {
  id: string;
  name: string;
  address: string;
  phone: string;
  website?: string;
  rating?: string;
  business_type?: string;
  location?: {
    lat: number;
    lng: number;
  };
  open_now?: boolean;
}

// Function to validate input
function validateInput(body: any) {
  // Check for required fields
  if (!body.siteId) {
    return { valid: false, error: 'siteId is required' };
  }
  
  if (!body.region) {
    return { valid: false, error: 'region is required' };
  }

  if (!body.maxLeads || body.maxLeads < 1 || body.maxLeads > 50) {
    return { valid: false, error: 'maxLeads must be between 1 and 50' };
  }
  
  return { valid: true };
}

// Function to search businesses in a region
async function searchRegionBusinesses(region: string, businessType: string, keywords: string[], limit: number): Promise<{success: boolean, businesses?: Business[], error?: string}> {
  try {
    // Call the region search API
    const searchResponse = await fetch(`${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000'}/api/agents/sales/region-search`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        siteId: process.env.INTERNAL_SITE_ID, // Use internal site ID for this search
        region,
        businessType,
        keywords,
        limit
      }),
    });
    
    if (!searchResponse.ok) {
      const errorData = await searchResponse.json();
      return { success: false, error: errorData.error?.message || 'Failed to search businesses' };
    }
    
    const searchData = await searchResponse.json();
    
    if (!searchData.success || !searchData.data?.businesses) {
      return { success: false, error: 'No businesses found' };
    }
    
    return {
      success: true,
      businesses: searchData.data.businesses
    };
  } catch (error) {
    console.error('Error searching businesses:', error);
    return { success: false, error: 'Failed to search businesses' };
  }
}

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
      maxLeads = 10,
      priority = "medium",
      productInfo = {},
      contactPreferences = {},
      lead_id,
      conversation_id,
      webhook
    } = body;
    
    // Generar comando para leads
    const commandResult = await regionLeadsCommandService.generateLeadsCommand({
      siteId,
      userId,
      region,
      businessType,
      keywords,
      maxLeads,
      priority,
      productInfo,
      contactPreferences,
      lead_id,
      conversation_id,
      webhook
    });
    
    if (!commandResult.success) {
      return NextResponse.json(
        { 
          success: false, 
          error: { 
            code: commandResult.error?.includes('not found') ? 'NOT_FOUND' : 'COMMAND_FAILED', 
            message: commandResult.error || 'Failed to generate region leads' 
          } 
        },
        { status: commandResult.error?.includes('not found') ? 404 : 500 }
      );
    }
    
    // Devolver respuesta exitosa
    return NextResponse.json({
      success: true,
      data: commandResult.data
    });
    
  } catch (error) {
    console.error('General error in region leads route:', error);
    
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