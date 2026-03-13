import { supabaseAdmin } from '@/lib/database/supabase-client';
import OpenAI from 'openai';

/**
 * Get OpenAI client for Azure OpenAI
 */
export function getOpenAIClient(): OpenAI {
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
export async function getConversationContext(instanceId: string, limit: number = 10): Promise<string> {
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
export async function getStoredObjective(instanceId: string): Promise<string | null> {
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
 * Extract a descriptive name from context by identifying key terms
 */
export function extractDescriptiveNameFromContext(context: string): string {
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
 * Generate a descriptive name based on context using AI
 */
export async function generateInstanceName(context: string, currentName?: string): Promise<string> {
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
 * Compare objectives using AI to determine if they're similar
 */
export async function compareObjectives(
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
