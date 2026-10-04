import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { createOpenRouterClient, resolveOpenRouterModel, isOpenRouterReasoningModel } from '@/lib/services/ai/openrouter';
import {
  batchCreateResponseNodes,
  updateNodeResult,
  failNode,
  fetchNodeContexts
} from '@/lib/services/robot-instance/assistant-logging';

function extractText(field: any): string {
  if (!field) return '';
  if (typeof field === 'string') {
    try { const parsed = JSON.parse(field); return parsed.text || field; } catch { return field; }
  }
  if (field.text) return field.text;
  return JSON.stringify(field);
}

function extractImageUrls(field: any): string[] {
  if (!field) return [];
  const parsed = typeof field === 'string'
    ? (() => { try { return JSON.parse(field); } catch { return null; } })()
    : field;

  if (!parsed?.outputs || !Array.isArray(parsed.outputs)) return [];

  return parsed.outputs
    .filter((o: any) => o?.type === 'image')
    .map((o: any) => (typeof o.data?.url === 'string' ? o.data.url : o.url) as string)
    .filter((url: string) => typeof url === 'string' && url.length > 0);
}

function buildContextContent(
  text: string,
  imageUrls: string[],
  label: string,
): string | any[] {
  if (imageUrls.length === 0) {
    return `[Context from node ${label}]: ${text}`;
  }

  const parts: any[] = [];
  
  // Include URLs in text so the LLM knows the actual strings to pass to tools
  const urlText = imageUrls.length > 0 ? `\nImage URLs for reference:\n${imageUrls.join('\n')}` : '';
  const combinedText = `[Context from node ${label}]: ${text}${urlText}`;
  
  parts.push({ type: 'text', text: combinedText });
  
  for (const url of imageUrls) {
    parts.push({ type: 'image_url', image_url: { url } });
  }
  return parts;
}

async function buildMessagesForNode(promptNodeId: string, promptNode: any): Promise<any[]> {
  const messages: any[] = [];

  // System prompt
  const systemPrompt = promptNode.settings?.systemPrompt
    || 'You are an AI assistant. You are helping the user with their request. You MUST answer directly to the user\'s prompt based on the context of the conversation. Never break character.';
  messages.push({ role: 'system', content: systemPrompt });

  // Resolve ancestor chain via RPC
  const { data: ancestors } = await supabaseAdmin
    .rpc('get_instance_node_ancestors', { p_node_id: promptNodeId });

  const trajectory = ancestors || [];

  // Resolve original chat context
  const rootNode = trajectory.length > 0 ? trajectory[0] : promptNode;
  if (rootNode.parent_instance_log_id) {
    const { data: rootLog } = await supabaseAdmin
      .from('instance_logs')
      .select('created_at, instance_id')
      .eq('id', rootNode.parent_instance_log_id)
      .single();

    if (rootLog) {
      const { data: logs } = await supabaseAdmin
        .from('instance_logs')
        .select('log_type, message, result, details')
        .eq('instance_id', rootLog.instance_id)
        .lte('created_at', rootLog.created_at)
        .in('log_type', ['user_action', 'agent_action'])
        .order('created_at', { ascending: true })
        .limit(10);

      if (logs) {
        for (const log of logs) {
          messages.push({
            role: log.log_type === 'user_action' ? 'user' : 'assistant',
            content: log.message
          });
        }
      }
    }
  }

  // Inject context nodes from instance_node_contexts (with multimodal image support)
  const contextEntries = await fetchNodeContexts(promptNodeId);
  for (const entry of contextEntries) {
    const raw = entry.type === 'prompt' ? entry.node.prompt : entry.node.result;
    const text = extractText(raw);
    const imageUrls = entry.type !== 'prompt' ? extractImageUrls(entry.node.result) : [];

    if ((text && text !== '{}') || imageUrls.length > 0) {
      messages.push({
        role: 'user',
        content: buildContextContent(text, imageUrls, entry.type),
      });
    }
  }

  // Inject ancestors as user/assistant pairs (with multimodal image support)
  for (const anc of trajectory) {
    const promptText = extractText(anc.prompt);
    if (promptText) messages.push({ role: 'user', content: promptText });

    const resultText = extractText(anc.result);
    const resultImageUrls = extractImageUrls(anc.result);

    if ((resultText && resultText !== '{}') || resultImageUrls.length > 0) {
      if (resultImageUrls.length > 0) {
        const parts: any[] = [];
        
        const urlText = resultImageUrls.length > 0 ? `\nImage URLs for reference:\n${resultImageUrls.join('\n')}` : '';
        const combinedText = resultText && resultText !== '{}' ? `${resultText}${urlText}` : urlText;
        
        if (combinedText) {
          parts.push({ type: 'text', text: combinedText });
        }
        
        for (const url of resultImageUrls) {
          parts.push({ type: 'image_url', image_url: { url } });
        }
        messages.push({ role: 'assistant', content: parts });
      } else {
        messages.push({ role: 'assistant', content: resultText });
      }
    }
  }

  return messages;
}

async function streamLLMIntoNode(
  messages: any[],
  responseNodeId: string,
  promptNode: any
): Promise<string> {
  const openrouter = createOpenRouterClient();
  const model = resolveOpenRouterModel(promptNode.settings?.model, promptNode.settings?.provider);
  const temperature = promptNode.settings?.temperature ?? 0.7;

  const stream = await openrouter.chat.completions.create({
    model, messages, stream: true,
    ...(isOpenRouterReasoningModel(model) ? {} : { temperature }),
    stream_options: { include_usage: true },
  });

  let accumulatedText = '';
  const generation: { gateway: string; model: string; id?: string; generation_id?: string;
    provider?: string; usage?: Record<string, any> } = { gateway: 'openrouter', model };
  let lastUpdate = Date.now();
  const THROTTLE_MS = 500;

  for await (const chunk of stream) {
    // The final usage-only frame can have an empty choices array.
    if (chunk.id) generation.id = generation.generation_id = chunk.id;
    if (chunk.model) generation.model = chunk.model;
    if ((chunk as any).provider) generation.provider = (chunk as any).provider;
    if (chunk.usage) generation.usage = { ...generation.usage, ...chunk.usage };
    const token = chunk.choices?.[0]?.delta?.content || '';
    if (token) {
      accumulatedText += token;
      const now = Date.now();
      if (now - lastUpdate > THROTTLE_MS) {
        await updateNodeResult(responseNodeId, { text: accumulatedText, status: 'streaming', ...generation });
        lastUpdate = now;
      }
    }
  }

  await updateNodeResult(responseNodeId, { text: accumulatedText, status: 'done', ...generation });
  return accumulatedText;
}

export async function POST(request: NextRequest) {
  let responseNodeIds: string[] = [];

  try {
    const { instance_node_id } = await request.json();

    if (!instance_node_id) {
      return NextResponse.json({ error: 'instance_node_id is required' }, { status: 400 });
    }

    // 1. Fetch the prompt node
    const { data: promptNode, error: fetchError } = await supabaseAdmin
      .from('instance_nodes')
      .select('*')
      .eq('id', instance_node_id)
      .single();

    if (fetchError || !promptNode) {
      return NextResponse.json({ error: 'instance_node_id not found' }, { status: 404 });
    }

    const expectedResults = promptNode.settings?.expected_results_amount || 1;

    // 2. Build messages (shared context for all response nodes)
    const messages = await buildMessagesForNode(instance_node_id, promptNode);

    // 3. Fetch context refs for linking
    const contextEntries = await fetchNodeContexts(instance_node_id);
    const contextRefs = contextEntries.map(e => ({
      context_node_id: e.context_node_id,
      type: e.type,
    }));

    // 4. Create N response nodes
    responseNodeIds = await batchCreateResponseNodes(
      instance_node_id, promptNode, expectedResults, contextRefs
    );

    console.log(`[Node Executor] Created ${responseNodeIds.length} response node(s) for prompt ${instance_node_id}`);

    // 5. Execute N parallel LLM calls, each streaming into its own node
    const results = await Promise.all(
      responseNodeIds.map(async (nodeId, index) => {
        try {
          const text = await streamLLMIntoNode([...messages], nodeId, promptNode);
          console.log(`[Node Executor] Response ${index + 1}/${expectedResults} done: ${nodeId}`);
          return { node_id: nodeId, status: 'completed', text };
        } catch (err: any) {
          await failNode(nodeId, 'OpenRouter generation failed');
          console.error(`[Node Executor] Response ${index + 1}/${expectedResults} failed: ${nodeId}`);
          return { node_id: nodeId, status: 'failed', error: 'OpenRouter generation failed' };
        }
      })
    );

    return NextResponse.json({
      success: true,
      instance_node_id,
      response_nodes: results
    });

  } catch (error: any) {
    console.error('[Node Executor] Request failed');

    for (const nodeId of responseNodeIds) {
      await failNode(nodeId, 'Node execution failed');
    }

    return NextResponse.json({ error: 'Node execution failed' }, { status: 500 });
  }
}
