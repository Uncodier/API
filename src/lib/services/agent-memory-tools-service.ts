/**
 * Agent Memory Tools Service
 * Save and retrieve assistant memories in agent_memories table
 */

import { supabaseAdmin } from '@/lib/database/supabase-client';
import { v4 as uuidv4 } from 'uuid';

export interface MemoryScope {
  client_id?: string;
  project_id?: string;
  task_id?: string;
}

export interface SaveOnAgentMemoryOptions {
  key?: string;
  summary?: string;
  type?: string;
  instance_id?: string;
  client_id?: string;
  project_id?: string;
  task_id?: string;
}

export interface GetAgentMemoriesOptions {
  search_query?: string;
  type?: string;
  limit?: number;
  instance_id?: string;
  client_id?: string;
  project_id?: string;
  task_id?: string;
}

export interface AgentMemoryResult {
  success: boolean;
  memoryId?: string;
  error?: string;
}

export interface GetAgentMemoriesResult {
  success: boolean;
  memories?: Array<{
    id: string;
    content: string;
    summary?: string;
    key: string;
    type: string;
    created_at: string;
    metadata?: Record<string, unknown>;
  }>;
  error?: string;
}

/**
 * Save content to agent_memories for the assistant
 */
export async function saveOnAgentMemory(
  agentId: string,
  userId: string,
  content: string,
  options?: SaveOnAgentMemoryOptions
): Promise<AgentMemoryResult> {
  try {
    if (!content || typeof content !== 'string') {
      return {
        success: false,
        error: 'Content is required and must be a non-empty string',
      };
    }

    const memoryId = uuidv4();
    const memoryKey =
      options?.key || `assistant_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    const memoryType = options?.type || 'assistant_note';

    const memoryData = {
      id: memoryId,
      agent_id: agentId,
      user_id: userId,
      type: memoryType,
      key: memoryKey,
      data: {
        content: content.trim(),
        summary: options?.summary,
        created_from: 'assistant_tool',
      },
      metadata: {
        source: 'save_on_memory_tool',
        instance_id: options?.instance_id || null,
        client_id: options?.client_id || null,
        project_id: options?.project_id || null,
        task_id: options?.task_id || null,
      },
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      access_count: 0,
      last_accessed: new Date().toISOString(),
    };

    const { data, error } = await supabaseAdmin
      .from('agent_memories')
      .insert([memoryData])
      .select('id')
      .single();

    if (error) {
      console.error('[AgentMemoryTools] Error saving memory:', error);
      return { success: false, error: error.message };
    }

    return { success: true, memoryId: data.id };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    console.error('[AgentMemoryTools] saveOnAgentMemory error:', err);
    return { success: false, error: msg };
  }
}

export interface GetContextMemoriesOptions {
  instance_id?: string;
  limit?: number;
}

/**
 * Get memories for assistant context injection (site_id, user_id, instance_id)
 * Fetches recent assistant_note memories for the agent/user, optionally scoped to instance
 */
export async function getContextMemories(
  agentId: string,
  userId: string,
  options?: GetContextMemoriesOptions
): Promise<string> {
  try {
    const limit = Math.min(options?.limit ?? 15, 30);

    const { data, error } = await supabaseAdmin
      .from('agent_memories')
      .select('id, data, metadata, created_at')
      .eq('agent_id', agentId)
      .eq('user_id', userId)
      .eq('type', 'assistant_note')
      .order('created_at', { ascending: false })
      .limit(limit * 2);

    if (error || !data || data.length === 0) {
      return '';
    }

    let rows = data;

    // Prefer instance-specific memories when instance_id provided
    if (options?.instance_id) {
      const instanceRows = rows.filter(
        (r) => (r.metadata as Record<string, unknown>)?.instance_id === options.instance_id
      );
      const otherRows = rows.filter(
        (r) => (r.metadata as Record<string, unknown>)?.instance_id !== options.instance_id
      );
      rows = [...instanceRows, ...otherRows];
    }

    const memories = rows.slice(0, limit).map((row) => {
      const d = (row.data as Record<string, unknown>) || {};
      const content = (d.content as string) || '';
      const scope = row.metadata as Record<string, unknown>;
      const scopeParts: string[] = [];
      if (scope?.client_id) scopeParts.push(`client:${scope.client_id}`);
      if (scope?.project_id) scopeParts.push(`project:${scope.project_id}`);
      if (scope?.task_id) scopeParts.push(`task:${scope.task_id}`);
      const scopeStr = scopeParts.length > 0 ? ` [${scopeParts.join(', ')}]` : '';
      return `- ${content}${scopeStr}`;
    });

    if (memories.length === 0) return '';

    return `\n\n🧠 RELEVANT MEMORIES (from past conversations):\n${memories.join('\n')}`;
  } catch (err) {
    console.error('[AgentMemoryTools] getContextMemories error:', err);
    return '';
  }
}

/**
 * Filter rows by scope (instance_id, client_id, project_id, task_id) in metadata
 */
function filterByScope(
  rows: Array<{ metadata?: Record<string, unknown> | null }>,
  scope: { instance_id?: string; client_id?: string; project_id?: string; task_id?: string }
): typeof rows {
  return rows.filter((row) => {
    const meta = row.metadata || {};
    if (scope.instance_id && meta.instance_id !== scope.instance_id) return false;
    if (scope.client_id && meta.client_id !== scope.client_id) return false;
    if (scope.project_id && meta.project_id !== scope.project_id) return false;
    if (scope.task_id && meta.task_id !== scope.task_id) return false;
    return true;
  });
}

/**
 * Get agent memories with optional search and scope filters
 */
export async function getAgentMemories(
  agentId: string,
  options?: GetAgentMemoriesOptions
): Promise<GetAgentMemoriesResult> {
  try {
    const limit = Math.min(options?.limit ?? 20, 50);
    const memoryType = options?.type || 'assistant_note';
    const searchQuery = options?.search_query?.trim();

    // Fetch extra rows when searching or scoping so client-side filter has enough data
    const fetchLimit = searchQuery ? Math.min(limit * 3, 50) : limit * 2;

    const { data, error } = await supabaseAdmin
      .from('agent_memories')
      .select('id, key, type, data, metadata, created_at')
      .eq('agent_id', agentId)
      .eq('type', memoryType)
      .order('created_at', { ascending: false })
      .limit(fetchLimit);

    if (error) {
      console.error('[AgentMemoryTools] Error fetching memories:', error);
      return { success: false, error: error.message };
    }

    let rows = data || [];

    // Filter by scope (instance_id, client_id, project_id, task_id)
    const hasScope =
      options?.instance_id || options?.client_id || options?.project_id || options?.task_id;
    if (hasScope) {
      rows = filterByScope(rows, {
        instance_id: options?.instance_id,
        client_id: options?.client_id,
        project_id: options?.project_id,
        task_id: options?.task_id,
      });
    }

    // Filter by search_query in key and content (client-side for JSONB safety)
    if (searchQuery) {
      const lower = searchQuery.toLowerCase();
      rows = rows.filter((row) => {
        const content = (row.data as Record<string, unknown>)?.content;
        const summary = (row.data as Record<string, unknown>)?.summary;
        const key = row.key || '';
        return (
          (typeof content === 'string' && content.toLowerCase().includes(lower)) ||
          (typeof summary === 'string' && summary.toLowerCase().includes(lower)) ||
          key.toLowerCase().includes(lower)
        );
      });
      rows = rows.slice(0, limit);
    } else if (hasScope) {
      rows = rows.slice(0, limit);
    }

    const memories = rows.map((row) => {
      const d = (row.data as Record<string, unknown>) || {};
      return {
        id: row.id,
        content: (d.content as string) || '',
        summary: d.summary as string | undefined,
        key: row.key,
        type: row.type,
        created_at: row.created_at,
        metadata: row.metadata as Record<string, unknown> | undefined,
      };
    });

    return { success: true, memories };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    console.error('[AgentMemoryTools] getAgentMemories error:', err);
    return { success: false, error: msg };
  }
}
