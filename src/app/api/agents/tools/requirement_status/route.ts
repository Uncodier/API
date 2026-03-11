import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/database/supabase-client';

export async function createRequirementStatusCore(params: {
  site_id: string;
  instance_id?: string;
  asset_id?: string;
  requirement_id: string;
  repo_url?: string;
  preview_url?: string;
  status?: string;
  message?: string;
}) {
  const { site_id, instance_id, asset_id, requirement_id, repo_url, preview_url, status, message } = params;

  if (!site_id || !instance_id || !requirement_id || !status) {
    throw new Error('site_id, instance_id, requirement_id, and status are required');
  }

  // Ensure asset_id is a valid UUID if provided, otherwise default to null to avoid database errors
  const isUuid = (str: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str);
  const validAssetId = asset_id && isUuid(asset_id) ? asset_id : null;

  // Insert into requirement_progress table (or requirement_status)
  const { data, error } = await supabaseAdmin
    .from('requirement_status')
    .insert([
      {
        site_id,
        instance_id,
        asset_id: validAssetId,
        requirement_id,
        repo_url: repo_url || null,
        preview_url: preview_url || null,
        status,
        message: message || null,
        created_at: new Date().toISOString(),
      }
    ])
    .select()
    .single();

  if (error) {
    throw new Error(`Error inserting requirement status: ${error.message}`);
  }

  // Optional: update the general status of the requirement in the requirements table
  if (status === 'completed' || status === 'done' || status === 'in-progress') {
    const mappedStatus = status === 'in-progress' ? 'in-progress' : (status === 'completed' || status === 'done' ? 'done' : undefined);
    if (mappedStatus) {
      await supabaseAdmin
        .from('requirements')
        .update({ status: mappedStatus, updated_at: new Date().toISOString() })
        .eq('id', requirement_id);
    }
  }

  return { success: true, data };
}

export async function listRequirementStatusCore(params: {
  requirement_id: string;
  instance_id?: string;
}) {
  const { requirement_id, instance_id } = params;

  let query = supabaseAdmin.from('requirement_status').select('*');

  if (requirement_id) {
    query = query.eq('requirement_id', requirement_id);
  }
  if (instance_id) {
    query = query.eq('instance_id', instance_id);
  }

  query = query.order('created_at', { ascending: false });

  const { data, error } = await query;

  if (error) {
    throw new Error(`Error getting requirement status: ${error.message}`);
  }

  return { success: true, data };
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const result = await createRequirementStatusCore(body);
    return NextResponse.json(result, { status: 201 });
  } catch (error: any) {
    console.error('Error in requirement_status tool:', error);
    return NextResponse.json(
      { success: false, error: error.message || 'Internal server error' },
      { status: error.message.includes('are required') ? 400 : 500 }
    );
  }
}

export async function GET(request: NextRequest) {
  try {
    const url = new URL(request.url);
    const requirement_id = url.searchParams.get('requirement_id');
    const instance_id = url.searchParams.get('instance_id');
    
    if (!requirement_id) {
      return NextResponse.json({ success: false, error: 'requirement_id is required' }, { status: 400 });
    }

    const result = await listRequirementStatusCore({ requirement_id, instance_id: instance_id || undefined });
    return NextResponse.json(result);
  } catch (error: any) {
    console.error('Error getting requirement_status:', error);
    return NextResponse.json(
      { success: false, error: error.message || 'Internal server error' },
      { status: 500 }
    );
  }
}
