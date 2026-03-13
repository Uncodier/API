import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { createOrResumeInstance } from '@/lib/services/robot-instance/instance-lifecycle';
import { autoAuthenticateInstance } from '@/lib/helpers/automation-auth';
import { 
  getConversationContext, 
  getStoredObjective, 
  generateInstanceName, 
  compareObjectives 
} from '@/lib/services/robot-instance/instance-naming';

// Function to validate UUIDs
function isValidUUID(uuid: string): boolean {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(uuid);
}

export interface InstanceCoreArgs {
  action: 'create' | 'read' | 'update';
  site_id?: string;
  instance_id?: string;
  user_id?: string;
  activity?: string;
  context?: string;
  name?: string;
  status?: string;
  limit?: number;
  offset?: number;
}

export async function instanceCore(args: InstanceCoreArgs) {
  const { action, site_id, instance_id, user_id, activity, context, name, status, limit = 10, offset = 0 } = args;

  if (action === 'create') {
    if (!site_id || !activity) {
      throw new Error('site_id and activity are required for create action');
    }
    
    console.log(`[INSTANCE_TOOL] 🚀 Creating instance for site ${site_id} with activity: ${activity}`);
    
    const { instanceRecord } = await createOrResumeInstance({
      siteId: site_id,
      activity
    });
    
    let authResult: any = { success: false };
    if (instanceRecord?.provider_instance_id) {
      try {
        console.log(`[INSTANCE_TOOL] Attempting auto-authentication for site_id: ${site_id}`);
        authResult = await autoAuthenticateInstance(instanceRecord.provider_instance_id, site_id);
      } catch (authErr) {
        console.warn('[INSTANCE_TOOL] Auto-authentication failed:', authErr);
      }
    }
    
    return {
      success: true,
      instance: instanceRecord,
      authentication: authResult
    };
  }
  
  if (action === 'read') {
    if (!site_id) {
      throw new Error('site_id is required for read action');
    }
    
    if (instance_id) {
      const { data, error } = await supabaseAdmin
        .from('remote_instances')
        .select('*')
        .eq('id', instance_id)
        .eq('site_id', site_id)
        .single();
        
      if (error) throw new Error(`Error fetching instance: ${error.message}`);
      return { success: true, instance: data };
    } else {
      const { data, error } = await supabaseAdmin
        .from('remote_instances')
        .select('*')
        .eq('site_id', site_id)
        .order('created_at', { ascending: false })
        .range(offset, offset + limit - 1);
        
      if (error) throw new Error(`Error listing instances: ${error.message}`);
      return { success: true, instances: data };
    }
  }

  if (action === 'update') {
    if (!instance_id || !site_id) {
      throw new Error('instance_id and site_id are required for update action');
    }
    
    if (!isValidUUID(instance_id) || !isValidUUID(site_id)) {
      throw new Error('Invalid UUID format');
    }
    
    // Explicit update
    if (name || status) {
      const updates: any = {};
      if (name) updates.name = name;
      if (status) updates.status = status;
      updates.updated_at = new Date().toISOString();
      
      const { data, error } = await supabaseAdmin
        .from('remote_instances')
        .update(updates)
        .eq('id', instance_id)
        .eq('site_id', site_id)
        .select()
        .single();
        
      if (error) throw new Error(`Failed to update instance: ${error.message}`);
      return { success: true, instance: data };
    }
    
    // Auto-rename logic based on context
    const { data: instance, error: instanceError } = await supabaseAdmin
      .from('remote_instances')
      .select('*')
      .eq('id', instance_id)
      .single();

    if (instanceError || !instance) throw new Error('Instance not found');
    if (instance.site_id !== site_id) throw new Error('Instance does not belong to this site');

    let conversationContext: string;
    if (context && context.trim().length > 0) {
      conversationContext = context.trim();
    } else {
      conversationContext = await getConversationContext(instance_id);
    }
    
    if (!conversationContext || conversationContext.trim().length === 0) {
      throw new Error('No context available to determine new name.');
    }

    const storedObjective = await getStoredObjective(instance_id);
    const comparison = await compareObjectives(storedObjective, conversationContext);

    if (comparison.similar && comparison.similarity >= 0.7) {
      return {
        success: true,
        renamed: false,
        reason: 'Objective has not changed significantly',
        current_name: instance.name,
        similarity: comparison.similarity,
      };
    }

    const newName = await generateInstanceName(conversationContext, instance.name);

    const updatedConfiguration = {
      ...(instance.configuration || {}),
      objective: conversationContext.substring(0, 500),
      last_renamed_at: new Date().toISOString(),
    };

    const { error: updateError } = await supabaseAdmin
      .from('remote_instances')
      .update({
        name: newName,
        configuration: updatedConfiguration,
        updated_at: new Date().toISOString(),
      })
      .eq('id', instance_id);

    if (updateError) throw new Error(`Failed to update instance name: ${updateError.message}`);

    await supabaseAdmin.from('instance_logs').insert({
      log_type: 'system',
      level: 'info',
      message: `Instance renamed from "${instance.name}" to "${newName}"`,
      details: { old_name: instance.name, new_name: newName, similarity: comparison.similarity, reason: 'Objective changed' },
      instance_id: instance_id,
      site_id: instance.site_id,
      user_id: instance.user_id,
    });

    return {
      success: true,
      renamed: true,
      old_name: instance.name,
      new_name: newName,
      similarity: comparison.similarity,
      message: `Instance renamed from "${instance.name}" to "${newName}"`,
    };
  }
  
  throw new Error('Invalid action');
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const result = await instanceCore(body);
    return NextResponse.json(result, { status: 200 });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 400 });
  }
}

export async function GET() {
  return NextResponse.json({
    message: 'Instance Tool API',
    description: 'Create, Read, Update AI assistant instances',
    usage: 'Send a POST request with action parameter: create, read, or update',
    endpoint: '/api/agents/tools/instance',
    methods: ['POST', 'GET'],
    actions: {
      create: {
        required_fields: ['action', 'site_id', 'activity'],
        response: { success: 'boolean', instance: 'object', authentication: 'object' }
      },
      read: {
        required_fields: ['action', 'site_id'],
        optional_fields: ['instance_id', 'limit', 'offset'],
        response: { success: 'boolean', instance: 'object', instances: 'array' }
      },
      update: {
        required_fields: ['action', 'site_id', 'instance_id'],
        optional_fields: ['name', 'status', 'context'],
        response: { success: 'boolean', instance: 'object', renamed: 'boolean' }
      }
    }
  });
}
