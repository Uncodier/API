import { supabaseAdmin } from '@/lib/database/supabase-client';
import { fetchNodeContexts } from './assistant-logging';
import type { AssistantExecutionOptions } from './assistant-execution-options';

/** Extract the requested prompt/result text without changing reference semantics. */
function extractNodeText(node: any, type: string): string {
  if (!node) return '';
  if (type === 'prompt') {
    if (!node.prompt) return '';
    if (typeof node.prompt === 'string') {
      try { return JSON.parse(node.prompt).text || node.prompt; } catch { return node.prompt; }
    }
    return node.prompt?.text || JSON.stringify(node.prompt);
  }
  const result = node.result;
  if (!result) return '';
  if (typeof result === 'string') {
    try { return JSON.parse(result).text || result; } catch { return result; }
  }
  if (result.text) return result.text;
  const text = JSON.stringify(result);
  return text === '{}' ? '' : text;
}

function parseJson(value: any): any {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return null; }
}

function extractNodeImageUrls(node: any): string[] {
  const urls: string[] = [];
  const result = parseJson(node?.result);
  if (Array.isArray(result?.outputs)) {
    urls.push(...result.outputs
      .filter((output: any) => output?.type === 'image')
      .map((output: any) => typeof output.data?.url === 'string' ? output.data.url : output.url)
      .filter((url: any) => typeof url === 'string' && url.length > 0));
  }
  const prompt = parseJson(node?.prompt);
  if (Array.isArray(prompt?.attachments)) {
    urls.push(...prompt.attachments.filter((attachment: any) =>
      typeof attachment === 'string' &&
      (attachment.includes('http') || attachment.includes('data:image'))));
  }
  if (prompt?.image_url) urls.push(prompt.image_url);
  return urls;
}

function referenceMessage(entry: { node: any; type: string }): any | undefined {
  const text = extractNodeText(entry.node, entry.type);
  const imageUrls = extractNodeImageUrls(entry.node);
  if (!text && imageUrls.length === 0) return undefined;
  const referenceText = `[Reference Context from linked node ${entry.type}]:\nPRIORITY: Please prioritize the assets (like images or text) from this reference node. The main prompt refers to these assets.\n\n${text}`;
  if (imageUrls.length === 0) return { role: 'user', content: referenceText };
  const urlText = `\n\nCRITICAL - Image URLs for reference (YOU MUST PASS THESE URLS EXACTLY AS THEY ARE TO THE APPROPRIATE TOOL PARAMETER, e.g. reference_images):\n${imageUrls.join('\n')}`;
  return {
    role: 'user',
    content: [
      { type: 'text', text: referenceText + urlText },
      ...imageUrls.map(url => ({ type: 'image_url', image_url: { url } })),
    ],
  };
}

/** Fail closed before using the server-only client for a node execution. */
export async function prepareNodeExecutionContext(
  messages: any[],
  systemPrompt: string,
  options: AssistantExecutionOptions,
) {
  const { instance_node_id: nodeId, instance_id: instanceId, site_id: siteId } = options;
  let promptNode: any = null;
  let responseNode: any = null;
  let contextEntries: Awaited<ReturnType<typeof fetchNodeContexts>> = [];
  if (!nodeId) {
    if (options.node_continuation) throw new Error('Node continuation requires a prompt node');
    return { messages, systemPrompt, promptNode, responseNode, contextRefs: [] };
  }
  if (!instanceId || !siteId) throw new Error('Node execution requires an instance and site scope');

  const scopedNode = (id: string) => supabaseAdmin.from('instance_nodes').select('*')
    .eq('id', id).eq('instance_id', instanceId).eq('site_id', siteId);
  const inScope = (node: any) => node?.instance_id === instanceId && node?.site_id === siteId;
  const { data, error } = await scopedNode(nodeId).single();
  if (error || !data || data.id !== nodeId || !inScope(data)) {
    throw new Error('Prompt node not found in the execution scope');
  }
  promptNode = data;
  systemPrompt += `\n\n=== NODE EXECUTION MODE ===
You are executing a specific Node in a visual Canvas workflow.
Your action must be based EXCLUSIVELY on the 'Reference Context' explicitly provided to you right before the final prompt.
Do NOT use general conversational history to infer which image/asset to edit. Use ONLY the URLs and text provided in the Reference Context.`;

  if (options.node_continuation) {
    const ids = options.node_continuation.responseNodeIds;
    if ((options.expected_results_amount || 1) !== 1 || !Array.isArray(ids) ||
        ids.length !== 1 || typeof ids[0] !== 'string' || !ids[0].trim()) {
      throw new Error('Only a single response node can be continued');
    }
    const { data: response, error: responseError } = await scopedNode(ids[0])
      .eq('parent_node_id', nodeId).eq('type', 'response').single();
    if (responseError || !response || response.id !== ids[0] || !inScope(response) ||
        ['stopped', 'cancelled'].includes(response.status) ||
        response.parent_node_id !== nodeId || response.type !== 'response') {
      throw new Error('Response node not found in the execution scope');
    }
    responseNode = response;
    // The full conversation already contains references and completed tool calls.
    // Never replace it with the last tool result or reinject current references.
  } else {
    messages = messages.length > 0 ? [messages[messages.length - 1]] : [];
    contextEntries = await fetchNodeContexts(nodeId, { instanceId, siteId });
    contextEntries = contextEntries.filter(entry => inScope(entry.node));
    if (promptNode.parent_node_id &&
        !contextEntries.some(entry => entry.context_node_id === promptNode.parent_node_id)) {
      const { data: parent, error: parentError } = await scopedNode(promptNode.parent_node_id).single();
      if (!parentError && parent?.id === promptNode.parent_node_id && inScope(parent)) {
        contextEntries.unshift({ context_node_id: parent.id, type: 'parent_reference', node: parent });
      }
    }
    const references = contextEntries.map(referenceMessage).filter(Boolean);
    messages = [...references, ...messages];
  }
  return {
    messages, systemPrompt, promptNode, responseNode,
    contextRefs: contextEntries.map(entry => ({ context_node_id: entry.context_node_id, type: entry.type })),
  };
}