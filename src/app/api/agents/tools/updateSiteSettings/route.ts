import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/database/supabase-client';

export interface UpdateSiteSettingsParams {
  about?: string;
  company_size?: string;
  industry?: string;
  branding?: any;
  customer_journey?: any;
  products?: any[];
  services?: any[];
  swot?: any;
  locations?: any[];
  marketing_budget?: any;
  marketing_channels?: any[];
  social_media?: any[];
  team_members?: any[];
  team_roles?: any[];
  org_structure?: any;
  competitors?: any[];
  goals?: any;
  channels?: any;
  business_hours?: any;
  press_releases?: any[];
  partnerships?: any[];
  competitor_info?: any;
  diversity_info?: any;
  office_locations?: any[];
}

/**
 * Core function to update site settings
 * @param site_id - The ID of the site to update settings for
 * @param params - The settings parameters to update
 * @returns Result object with success status and details
 */
export async function updateSiteSettingsCore(site_id: string, params: UpdateSiteSettingsParams) {
  try {
    console.log(`[UpdateSiteSettings] 🔧 Updating settings for site: ${site_id}`);
    
    // Filter out undefined values
    const updates: any = {};
    Object.keys(params).forEach(key => {
      if ((params as any)[key] !== undefined) {
        updates[key] = (params as any)[key];
      }
    });

    if (Object.keys(updates).length === 0) {
      return {
        success: false,
        message: 'No settings provided to update',
        updated: false
      };
    }

    // Check if settings record exists first
    const { data: existingSettings, error: fetchError } = await supabaseAdmin
      .from('settings')
      .select('id')
      .eq('site_id', site_id)
      .single();

    if (fetchError && fetchError.code !== 'PGRST116') {
      console.error(`[UpdateSiteSettings] ❌ Error fetching existing settings:`, fetchError);
      throw new Error(`Failed to fetch existing settings: ${fetchError.message}`);
    }

    let result;
    
    if (!existingSettings) {
      // Create new settings record if it doesn't exist
      console.log(`[UpdateSiteSettings] 🆕 Creating new settings record for site: ${site_id}`);
      const { data, error } = await supabaseAdmin
        .from('settings')
        .insert({
          site_id,
          ...updates
        })
        .select()
        .single();
        
      if (error) {
        console.error(`[UpdateSiteSettings] ❌ Error creating settings:`, error);
        throw new Error(`Failed to create settings: ${error.message}`);
      }
      result = data;
    } else {
      // Update existing settings record
      console.log(`[UpdateSiteSettings] 📝 Updating existing settings record: ${existingSettings.id}`);
      
      const { data, error } = await supabaseAdmin
        .from('settings')
        .update(updates)
        .eq('site_id', site_id)
        .select()
        .single();
        
      if (error) {
        console.error(`[UpdateSiteSettings] ❌ Error updating settings:`, error);
        throw new Error(`Failed to update settings: ${error.message}`);
      }
      result = data;
    }

    console.log(`[UpdateSiteSettings] ✅ Settings updated successfully`);
    
    return {
      success: true,
      updated: true,
      message: 'Settings updated successfully',
      updated_fields: Object.keys(updates)
    };
    
  } catch (error: any) {
    console.error(`[UpdateSiteSettings] ❌ Unexpected error:`, error);
    return {
      success: false,
      updated: false,
      message: error.message || 'An unexpected error occurred',
      error: error
    };
  }
}

/**
 * POST endpoint to update site settings
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { site_id, ...params } = body;

    if (!site_id) {
      return NextResponse.json(
        { success: false, error: 'site_id is required' },
        { status: 400 }
      );
    }

    const result = await updateSiteSettingsCore(site_id, params);
    
    const status = result.success ? 200 : 400;
    return NextResponse.json(result, { status });
  } catch (error: any) {
    console.error('[UpdateSiteSettings] ❌ Error processing request:', error);
    return NextResponse.json(
      {
        success: false,
        error: error.message || 'Internal server error'
      },
      { status: 500 }
    );
  }
}
