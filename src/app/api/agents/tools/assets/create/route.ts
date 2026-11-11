import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createAssetCore } from './core';
import { canToolPrincipalAccessSite, resolveToolRequestPrincipal } from '@/lib/security/tool-request-principal';

export async function POST(request: NextRequest) {
  try {
    const principal = await resolveToolRequestPrincipal(request);
    if (!principal) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
    const body = await request.json();
    const site = z.string().uuid().parse(body.site_id);
    if (!await canToolPrincipalAccessSite(principal, site)) {
      return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 });
    }
    
    // We can call the core function. 
    // Note: The core function throws errors, so we catch them here.
    const asset = await createAssetCore(body);

    return NextResponse.json({
      success: true,
      asset,
    }, { status: 201 });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({
        success: false,
        error: 'Invalid input',
        details: error.errors,
      }, { status: 400 });
    }
    
    // Handle specific errors thrown by core
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    
    if (errorMessage === 'Instance not found') {
       return NextResponse.json({ success: false, error: errorMessage }, { status: 404 });
    }
    if (errorMessage === 'La instancia no pertenece a este sitio') {
       return NextResponse.json({ success: false, error: errorMessage }, { status: 403 });
    }
    if (errorMessage === 'Inline assets require a text file type') {
      return NextResponse.json({ success: false, error: errorMessage }, { status: 400 });
    }

    return NextResponse.json({
      success: false,
      error: errorMessage,
    }, { status: 500 });
  }
}
