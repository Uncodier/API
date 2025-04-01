import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { supabaseAdmin } from '@/lib/database/supabase-client'
import { v4 as uuidv4 } from 'uuid'

// Validation schema for site creation
const createSiteSchema = z.object({
  name: z.string(),
  domain: z.string().optional()
});

// Validation schema for site retrieval
const getSiteSchema = z.object({
  id: z.string().uuid()
});

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const validatedData = createSiteSchema.parse(body);

    const siteId = uuidv4();
    const { data: site, error } = await supabaseAdmin
      .from('sites')
      .insert([{
        id: siteId,
        name: validatedData.name,
        domain: validatedData.domain,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      }])
      .select()
      .single();

    if (error) {
      console.error('Error creating site:', error);
      return NextResponse.json(
        {
          success: false,
          error: {
            code: 'site_creation_error',
            message: 'Error creating site'
          }
        },
        { status: 500 }
      );
    }

    return NextResponse.json({
      success: true,
      site
    });

  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        {
          success: false,
          error: {
            code: 'invalid_parameters',
            message: 'Invalid request parameters',
            details: error.errors
          }
        },
        { status: 400 }
      );
    }

    return NextResponse.json(
      {
        success: false,
        error: {
          code: 'internal_error',
          message: 'Internal server error'
        }
      },
      { status: 500 }
    );
  }
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get('id');

    if (!id) {
      // If no ID provided, return all sites
      const { data: sites, error } = await supabaseAdmin
        .from('sites')
        .select('*')
        .order('created_at', { ascending: false });

      if (error) {
        console.error('Error fetching sites:', error);
        return NextResponse.json(
          {
            success: false,
            error: {
              code: 'sites_fetch_error',
              message: 'Error fetching sites'
            }
          },
          { status: 500 }
        );
      }

      return NextResponse.json({
        success: true,
        sites
      });
    }

    // If ID provided, validate and fetch specific site
    const validatedData = getSiteSchema.parse({ id });
    const { data: site, error } = await supabaseAdmin
      .from('sites')
      .select('*')
      .eq('id', validatedData.id)
      .single();

    if (error) {
      console.error('Error fetching site:', error);
      return NextResponse.json(
        {
          success: false,
          error: {
            code: 'site_fetch_error',
            message: 'Error fetching site'
          }
        },
        { status: 500 }
      );
    }

    if (!site) {
      return NextResponse.json(
        {
          success: false,
          error: {
            code: 'site_not_found',
            message: 'Site not found'
          }
        },
        { status: 404 }
      );
    }

    return NextResponse.json({
      success: true,
      site
    });

  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        {
          success: false,
          error: {
            code: 'invalid_parameters',
            message: 'Invalid request parameters',
            details: error.errors
          }
        },
        { status: 400 }
      );
    }

    return NextResponse.json(
      {
        success: false,
        error: {
          code: 'internal_error',
          message: 'Internal server error'
        }
      },
      { status: 500 }
    );
  }
} 