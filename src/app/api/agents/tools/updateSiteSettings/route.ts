import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/database/supabase-client';

export interface SiteSettingsParams {
  action: 'get' | 'update';
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
 * Core function to manage site settings (get or update)
 * @param site_id - The ID of the site
 * @param params - The settings parameters (must include action)
 * @returns Result object with success status and details
 */
export async function siteSettingsCore(site_id: string, params: SiteSettingsParams) {
  try {
    const { action, ...updatesParams } = params;

    if (action === 'get') {
      console.log(`[SiteSettings] 🔍 Getting settings for site: ${site_id}`);
      
      const { data: settings, error: fetchError } = await supabaseAdmin
        .from('settings')
        .select('*')
        .eq('site_id', site_id)
        .single();

      if (fetchError && fetchError.code !== 'PGRST116') {
        console.error(`[SiteSettings] ❌ Error fetching settings:`, fetchError);
        throw new Error(`Failed to fetch settings: ${fetchError.message}`);
      }

      return {
        success: true,
        data: settings || {},
        message: settings ? 'Settings retrieved successfully' : 'No settings found'
      };
    }

    if (action === 'update') {
      console.log(`[SiteSettings] 🔧 Updating settings for site: ${site_id}`);
      
      // Filter out undefined values
      const updates: any = {};
      Object.keys(updatesParams).forEach(key => {
        if ((updatesParams as any)[key] !== undefined) {
          updates[key] = (updatesParams as any)[key];
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
        console.error(`[SiteSettings] ❌ Error fetching existing settings:`, fetchError);
        throw new Error(`Failed to fetch existing settings: ${fetchError.message}`);
      }

      let result;
      
      if (!existingSettings) {
        // Create new settings record if it doesn't exist
        console.log(`[SiteSettings] 🆕 Creating new settings record for site: ${site_id}`);
        const { data, error } = await supabaseAdmin
          .from('settings')
          .insert({
            site_id,
            ...updates
          })
          .select()
          .single();
          
        if (error) {
          console.error(`[SiteSettings] ❌ Error creating settings:`, error);
          throw new Error(`Failed to create settings: ${error.message}`);
        }
        result = data;
      } else {
        // Update existing settings record
        console.log(`[SiteSettings] 📝 Updating existing settings record: ${existingSettings.id}`);
        
        const { data, error } = await supabaseAdmin
          .from('settings')
          .update(updates)
          .eq('site_id', site_id)
          .select()
          .single();
          
        if (error) {
          console.error(`[SiteSettings] ❌ Error updating settings:`, error);
          throw new Error(`Failed to update settings: ${error.message}`);
        }
        result = data;
      }

      console.log(`[SiteSettings] ✅ Settings updated successfully`);
      
      return {
        success: true,
        updated: true,
        message: 'Settings updated successfully',
        updated_fields: Object.keys(updates)
      };
    }

    return {
      success: false,
      message: 'Invalid action provided. Must be "get" or "update"'
    };
    
  } catch (error: any) {
    console.error(`[SiteSettings] ❌ Unexpected error:`, error);
    return {
      success: false,
      updated: false,
      message: error.message || 'An unexpected error occurred',
      error: error
    };
  }
}

/**
 * POST endpoint to manage site settings
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

    const result = await siteSettingsCore(site_id, params);
    
    const status = result.success ? 200 : 400;
    return NextResponse.json(result, { status });
  } catch (error: any) {
    console.error('[SiteSettings] ❌ Error processing request:', error);
    return NextResponse.json(
      {
        success: false,
        error: error.message || 'Internal server error'
      },
      { status: 500 }
    );
  }
}
