import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { executeAssistant } from '@/lib/services/robot-instance/assistant-executor';
import OpenAI from 'openai';

import { createOrResumeInstance } from '@/lib/services/robot-instance/instance-lifecycle';
import { autoAuthenticateInstance } from '@/lib/helpers/automation-auth';

// Function to validate UUIDs
function isValidUUID(uuid: string): boolean {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(uuid);
}

/**
 * Get OpenAI client for Azure OpenAI
 */
function getOpenAIClient(): OpenAI {
  const apiKey = process.env.MICROSOFT_AZURE_OPENAI_API_KEY;
  const endpoint = process.env.MICROSOFT_AZURE_OPENAI_ENDPOINT;
  const deployment = process.env.MICROSOFT_AZURE_OPENAI_DEPLOYMENT || 'gpt-4o';
  const apiVersion = process.env.MICROSOFT_AZURE_OPENAI_API_VERSION || '2024-08-01-preview';

  if (!endpoint || !apiKey) {
    throw new Error('Azure OpenAI configuration is required');
  }

  return new OpenAI({
    apiKey: apiKey,
    baseURL: `${endpoint}/openai/deployments/${deployment}`,
    defaultQuery: { 'api-version': apiVersion },
    defaultHeaders: { 'api-key': apiKey },
  });
}

/**
 * Get recent conversation context from instance logs
 */
async function getConversationContext(instanceId: string, limit: number = 10): Promise<string> {
  const { data: logs } = await supabaseAdmin
    .from('instance_logs')
    .select('log_type, message, created_at')
    .eq('instance_id', instanceId)
    .in('log_type', ['user_action', 'agent_action'])
    .order('created_at', { ascending: false })
    .limit(limit);

  if (!logs || logs.length === 0) {
    return '';
  }

  return logs
    .reverse()
    .map(log => {
      const role = log.log_type === 'user_action' ? 'User' : 'Assistant';
      return `${role}: ${log.message}`;
    })
    .join('\n');
}

/**
 * Get stored objective from instance configuration or instance_plans
 */
async function getStoredObjective(instanceId: string): Promise<string | null> {
  // First, try to get from instance configuration
  const { data: instance } = await supabaseAdmin
    .from('remote_instances')
    .select('configuration')
    .eq('id', instanceId)
    .single();

  if (instance?.configuration?.objective) {
    return instance.configuration.objective;
  }

  // Fallback: get from instance_plans where plan_type = 'objective'
  const { data: objectivePlan } = await supabaseAdmin
    .from('instance_plans')
    .select('title, description, instructions')
    .eq('instance_id', instanceId)
    .eq('plan_type', 'objective')
    .order('created_at', { ascending: false })
    .limit(1)
    .single();

  if (objectivePlan) {
    return objectivePlan.description || objectivePlan.title || objectivePlan.instructions || null;
  }

  return null;
}

/**
 * Generate a descriptive name based on context using AI
 */
async function generateInstanceName(context: string, currentName?: string): Promise<string> {
  const client = getOpenAIClient();
  const deployment = process.env.MICROSOFT_AZURE_OPENAI_DEPLOYMENT || 'gpt-4o';

  // Check if current name is generic
  const genericNames = ['Assistant Session', 'New Instance', 'Untitled', 'Instance', 'Session', 'Assistant'];
  const isGenericName = currentName && genericNames.some(generic => 
    currentName.toLowerCase().includes(generic.toLowerCase())
  );

  const prompt = `You are generating a descriptive name for an AI assistant instance based on the user's context.

USER CONTEXT:
${context}

${isGenericName ? `⚠️ CRITICAL: The current name "${currentName}" is generic and must be replaced.\n` : ''}

TASK: Generate a concise, descriptive name (3-8 words) that accurately reflects the purpose described in the context above.

REQUIREMENTS:
1. Generate ONLY the name itself - no explanations, no quotes, no prefixes like "Name:" or "The name is:"
2. The name must be 3-8 words
3. Must be specific and descriptive - reflect the actual purpose/objective from the context
4. NEVER use generic names: "Assistant Session", "New Instance", "Untitled", "Instance", "Session", "Assistant"
5. Use keywords from the context to make it descriptive

EXAMPLES OF GOOD NAMES:
- Context: "Chat en español para soporte de marketing" → Name: "Marketing Support Spanish Chat"
- Context: "Lead research and qualification" → Name: "Lead Research Assistant"
- Context: "Content generation for social media" → Name: "Social Media Content Generator"
- Context: "Customer support in English" → Name: "English Customer Support"

Based on the context above, generate the name now:

Name:`;

  try {
    const response = await client.chat.completions.create({
      model: deployment,
      messages: [
        {
          role: 'system',
          content: 'You are a helpful assistant that generates concise, descriptive names for AI instances based on conversation context. You always generate new, specific names that reflect the actual purpose, never generic names.',
        },
        {
          role: 'user',
          content: prompt,
        },
      ],
      temperature: 0.8,
      max_completion_tokens: 30,
    });

    let generatedName = response.choices[0]?.message?.content?.trim() || '';
    
    // Clean up the name (remove quotes, extra spaces, prefixes like "Name:", etc.)
    generatedName = generatedName
      .replace(/^["']|["']$/g, '') // Remove surrounding quotes
      .replace(/^name:\s*/i, '') // Remove "Name:" prefix
      .replace(/^the name is:\s*/i, '') // Remove "The name is:" prefix
      .trim();

    // Validate that it's not empty or generic
    if (!generatedName || generatedName.length < 3) {
      console.warn(`[INSTANCE_TOOL] Generated name too short or empty, generating fallback from context`);
      generatedName = extractDescriptiveNameFromContext(context);
    }

    // Double-check: if it's still generic, force a descriptive name from context
    const isStillGeneric = genericNames.some(generic => 
      generatedName.toLowerCase().includes(generic.toLowerCase())
    );
    
    if (isStillGeneric) {
      console.warn(`[INSTANCE_TOOL] Generated name "${generatedName}" is still generic, creating descriptive fallback from context`);
      generatedName = extractDescriptiveNameFromContext(context);
    }

    // Final validation: ensure it's not generic
    const finalCheck = genericNames.some(generic => 
      generatedName.toLowerCase().includes(generic.toLowerCase())
    );
    if (finalCheck) {
      console.error(`[INSTANCE_TOOL] Name "${generatedName}" failed final validation, using context-based name`);
      generatedName = extractDescriptiveNameFromContext(context);
    }

    return generatedName;
  } catch (error: any) {
    console.error('[INSTANCE_TOOL] Error generating name:', error);
    // Fallback: extract descriptive name from context
    return extractDescriptiveNameFromContext(context);
  }
}

/**
 * Extract a descriptive name from context by identifying key terms
 */
function extractDescriptiveNameFromContext(context: string): string {
  const contextLower = context.toLowerCase();
  const genericNames = ['assistant', 'session', 'instance', 'new', 'untitled', 'the', 'a', 'an', 'for', 'with', 'and', 'or', 'to', 'of', 'in', 'on', 'at', 'by'];
  
  // Extract key descriptive terms from context
  let descriptiveTerms: string[] = [];
  
  // Language detection
  if (contextLower.includes('español') || contextLower.includes('spanish')) descriptiveTerms.push('Spanish');
  if (contextLower.includes('english') || contextLower.includes('inglés')) descriptiveTerms.push('English');
  
  // Purpose/function detection
  if (contextLower.includes('marketing') || contextLower.includes('marketing')) descriptiveTerms.push('Marketing');
  if (contextLower.includes('soporte') || contextLower.includes('support')) descriptiveTerms.push('Support');
  if (contextLower.includes('lead') || contextLower.includes('prospecto')) descriptiveTerms.push('Lead');
  if (contextLower.includes('chat') || contextLower.includes('conversación')) descriptiveTerms.push('Chat');
  if (contextLower.includes('crecimiento') || contextLower.includes('growth')) descriptiveTerms.push('Growth');
  if (contextLower.includes('awareness') || contextLower.includes('conciencia')) descriptiveTerms.push('Awareness');
  if (contextLower.includes('contacto') || contextLower.includes('contact')) descriptiveTerms.push('Contact');
  if (contextLower.includes('ventas') || contextLower.includes('sales')) descriptiveTerms.push('Sales');
  if (contextLower.includes('contenido') || contextLower.includes('content')) descriptiveTerms.push('Content');
  if (contextLower.includes('automatización') || contextLower.includes('automation')) descriptiveTerms.push('Automation');
  
  // If we found descriptive terms, use them
  if (descriptiveTerms.length > 0) {
    // Limit to 3-4 terms max
    return descriptiveTerms.slice(0, 4).join(' ');
  }
  
  // Fallback: extract meaningful words (longer than 4 chars, not generic)
  const words = context
    .split(/\s+/)
    .filter(w => {
      const word = w.toLowerCase().replace(/[.,;:!?()]/g, '');
      return word.length > 4 && !genericNames.includes(word);
    })
    .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .filter(w => w.length > 0);
  
  if (words.length > 0) {
    return words.slice(0, 3).join(' ');
  }
  
  // Last resort
  return 'Custom Assistant';
}

/**
 * Compare objectives using AI to determine if they're similar
 */
async function compareObjectives(
  storedObjective: string | null,
  newContext: string
): Promise<{ similar: boolean; similarity: number }> {
  // If no stored objective, they're not similar (allow rename)
  if (!storedObjective) {
    return { similar: false, similarity: 0 };
  }

  const client = getOpenAIClient();
  const deployment = process.env.MICROSOFT_AZURE_OPENAI_DEPLOYMENT || 'gpt-4o';

  const prompt = `Compare these two objectives and determine if they are similar (same or related purpose).

Stored Objective: ${storedObjective}
New Context: ${newContext}

Respond with a JSON object containing:
- "similar": boolean (true if objectives are similar/related, false if different)
- "similarity": number (0.0 to 1.0, where 1.0 is identical and 0.0 is completely different)

Only respond with valid JSON, nothing else.`;

  try {
    const response = await client.chat.completions.create({
      model: deployment,
      messages: [
        {
          role: 'system',
          content: 'You are a helpful assistant that compares objectives and determines similarity. Always respond with valid JSON only.',
        },
        {
          role: 'user',
          content: prompt,
        },
      ],
      temperature: 0.3,
      max_completion_tokens: 100,
      response_format: { type: 'json_object' },
    });

    const result = JSON.parse(response.choices[0]?.message?.content || '{"similar": false, "similarity": 0}');
    return {
      similar: result.similar === true,
      similarity: typeof result.similarity === 'number' ? result.similarity : 0,
    };
  } catch (error: any) {
    console.error('[INSTANCE_TOOL] Error comparing objectives:', error);
    // On error, default to not similar (allow rename)
    return { similar: false, similarity: 0 };
  }
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
