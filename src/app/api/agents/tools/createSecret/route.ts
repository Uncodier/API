import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/database/supabase-client';

export interface CreateSecretParams {
  name: string;
  description: string;
  secret: string;
}

/**
 * Core function to create a secret in Supabase Vault
 * @param site_id - The ID of the site (used for scoping/naming if needed, or logging)
 * @param params - The secret parameters
 * @returns Result object with success status and details
 */
export async function createSecretCore(site_id: string, params: CreateSecretParams) {
  try {
    console.log(`[CreateSecret] 🔐 Creating secret "${params.name}" for site: ${site_id}`);
    
    // Check required fields
    if (!params.name || !params.secret) {
      return {
        success: false,
        message: 'Name and secret are required fields'
      };
    }

    // Try to insert using supabaseAdmin with the vault schema
    const { data, error } = await supabaseAdmin.rpc('insert_secret', {
      name: params.name,
      secret: params.secret,
      description: params.description || `Created for site ${site_id}`
    });
    
    // If insert_secret RPC doesn't exist, we can try inserting directly or using create_secret if it's the default supabase vault RPC.
    // Actually, vault.create_secret is the standard Supabase Vault RPC.
    // Let's try direct insertion as a fallback if RPC fails
    if (error) {
      console.log(`[CreateSecret] RPC failed, trying direct insert or standard vault RPC...`, error.message);
      
      // Standard vault function is often vault.insert_secret or we can just try to insert into vault.secrets
      const { data: directData, error: directError } = await supabaseAdmin
        .schema('vault')
        .from('secrets')
        .insert({
          name: params.name,
          description: params.description || `Created for site ${site_id}`,
          secret: params.secret,
        })
        .select('id, name, description, created_at')
        .single();
        
      if (directError) {
         console.error(`[CreateSecret] ❌ Error creating secret:`, directError);
         return {
           success: false,
           message: `Failed to create secret: ${directError.message}`,
           error: directError.message || String(directError)
         };
      }
      
      console.log(`[CreateSecret] ✅ Secret created successfully via direct insert`);
      return {
        success: true,
        message: 'Secret created successfully',
        data: directData
      };
    }

    console.log(`[CreateSecret] ✅ Secret created successfully via RPC`);
    
    // Normalize data shape to match direct insert
    // Supabase RPC typically returns the UUID string for insert_secret
    const secretId = typeof data === 'string' ? data : data?.id;
    
    const normalizedData = {
      id: secretId || null,
      name: params.name,
      description: params.description || `Created for site ${site_id}`,
      created_at: data?.created_at || new Date().toISOString()
    };

    return {
      success: true,
      message: 'Secret created successfully',
      data: normalizedData
    };
    
  } catch (error: any) {
    console.error(`[CreateSecret] ❌ Unexpected error:`, error);
    return {
      success: false,
      message: error.message || 'An unexpected error occurred',
      error: error.message || String(error)
    };
  }
}

/**
 * POST endpoint to create a secret
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

    const result = await createSecretCore(site_id, params);
    
    const status = result.success ? 200 : 400;
    return NextResponse.json(result, { status });
  } catch (error: any) {
    console.error('[CreateSecret] ❌ Error processing request:', error);
    return NextResponse.json(
      {
        success: false,
        error: error.message || 'Internal server error'
      },
      { status: 500 }
    );
  }
}
