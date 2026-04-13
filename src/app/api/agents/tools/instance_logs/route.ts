import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { CreditService } from '@/lib/services/billing/CreditService';

function parseJsonIfString<T>(value: T | string | undefined): T | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') return value as T;
  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
}

export type CreateInstanceLogParams = {
  site_id: string;
  instance_id?: string;
  user_id?: string;
  log_type: string;
  level: string;
  message: string;
  details?: Record<string, any> | string;
  tokens_used?: Record<string, any>;
  tool_name?: string | null;
  tool_call_id?: string | null;
  tool_args?: Record<string, any> | string | null;
  tool_result?: Record<string, any> | string | null;
  step_id?: string | null;
  parent_log_id?: string | null;
  agent_id?: string | null;
  command_id?: string | null;
  is_error?: boolean | null;
  duration_ms?: number | null;
  screenshot_base64?: string | null;
  artifacts?: unknown[] | null;
};

export async function createInstanceLogCore(params: CreateInstanceLogParams) {
  const {
    site_id,
    instance_id,
    user_id,
    log_type,
    level,
    message,
    details: rawDetails,
    tokens_used,
    tool_name,
    tool_call_id,
    tool_args: rawToolArgs,
    tool_result: rawToolResult,
    step_id,
    parent_log_id,
    agent_id,
    command_id,
    is_error,
    duration_ms,
    screenshot_base64,
    artifacts: rawArtifacts,
  } = params;

  const details =
    rawDetails === undefined || rawDetails === null
      ? rawDetails
      : typeof rawDetails === 'string'
        ? parseJsonIfString<Record<string, any>>(rawDetails) ?? null
        : rawDetails;

  const normalizeJsonObject = (
    raw: Record<string, any> | string | null | undefined
  ): Record<string, any> | null | undefined => {
    if (raw === undefined) return undefined;
    if (raw === null) return null;
    if (typeof raw === 'string') return parseJsonIfString<Record<string, any>>(raw) ?? null;
    return raw;
  };

  const normalizeArtifacts = (
    raw: unknown[] | string | null | undefined
  ): unknown[] | null | undefined => {
    if (raw === undefined) return undefined;
    if (raw === null) return null;
    if (typeof raw === 'string') return parseJsonIfString<unknown[]>(raw) ?? null;
    return Array.isArray(raw) ? raw : null;
  };

  const tool_args = normalizeJsonObject(rawToolArgs as any);
  const tool_result = normalizeJsonObject(rawToolResult as any);
  const artifacts = normalizeArtifacts(rawArtifacts as any);

  if (!site_id || !log_type || !level || !message) {
    throw new Error('site_id, log_type, level, and message are required');
  }

  // Deduct credits if token usage is provided (either in tokens_used or details.usage)
  let inputTokens = 0;
  let outputTokens = 0;
  
  if (tokens_used) {
    inputTokens = tokens_used.promptTokens || tokens_used.input_tokens || tokens_used.prompt_tokens || 0;
    outputTokens = tokens_used.completionTokens || tokens_used.output_tokens || tokens_used.completion_tokens || 0;
  } else if (details?.usage) {
    inputTokens = details.usage.promptTokens || details.usage.input_tokens || details.usage.prompt_tokens || 0;
    outputTokens = details.usage.completionTokens || details.usage.output_tokens || details.usage.completion_tokens || 0;
  }

  const totalTokens = inputTokens + outputTokens;

  if (totalTokens > 0) {
    // Correct pricing: 1 credit per 1 million tokens
    const tokensCost = (totalTokens / 1_000_000) * CreditService.PRICING.ASSISTANT_TOKEN_MILLION;
    
    if (tokensCost > 0) {
      try {
        await CreditService.deductCredits(
          site_id,
          tokensCost,
          'assistant_tokens',
          `Assistant execution (${totalTokens} tokens)`,
          {
            tokens: totalTokens,
            input_tokens: inputTokens,
            output_tokens: outputTokens,
            instance_id: instance_id || 'unknown',
            log_type
          }
        );
      } catch (e) {
        console.error('Failed to deduct credits for instance_log tokens:', e);
        // If the error is insufficient credits, we might want to fail the log or just record it
        // Based on assistant-executor.ts, it logs the error but continues, or throws if before execution.
        // Since this is logging an already executed action, we shouldn't throw to avoid losing the log.
      }
    }
  }

  const insertRow: Record<string, unknown> = {
    site_id,
    instance_id: instance_id || null,
    user_id: user_id || null,
    log_type,
    level,
    message,
    details: details ?? null,
    tokens_used: tokens_used || (details && typeof details === 'object' && details.usage ? {
      promptTokens: inputTokens,
      completionTokens: outputTokens,
      totalTokens: totalTokens
    } : null),
    created_at: new Date().toISOString(),
  };

  const optionalColumns: Record<string, unknown> = {
    tool_name,
    tool_call_id,
    tool_args,
    tool_result,
    step_id,
    parent_log_id,
    agent_id,
    command_id,
    is_error,
    duration_ms,
    screenshot_base64,
    artifacts,
  };
  for (const [key, value] of Object.entries(optionalColumns)) {
    if (value !== undefined) {
      insertRow[key] = value;
    }
  }

  const { data, error } = await supabaseAdmin
    .from('instance_logs')
    .insert([insertRow as any])
    .select()
    .single();

  if (error) {
    throw new Error(`Error inserting instance log: ${error.message}`);
  }

  return { success: true, data };
}

export async function listInstanceLogsCore(params: {
  site_id: string;
  instance_id?: string;
  user_id?: string;
  log_type?: string;
  level?: string;
  limit?: number;
  offset?: number;
}) {
  const { site_id, instance_id, user_id, log_type, level, limit = 50, offset = 0 } = params;

  let query = supabaseAdmin.from('instance_logs').select('*');

  if (site_id) {
    query = query.eq('site_id', site_id);
  }
  if (instance_id) {
    query = query.eq('instance_id', instance_id);
  }
  if (user_id) {
    query = query.eq('user_id', user_id);
  }
  if (log_type) {
    query = query.eq('log_type', log_type);
  }
  if (level) {
    query = query.eq('level', level);
  }

  query = query.order('created_at', { ascending: false }).range(offset, offset + limit - 1);

  const { data, error } = await query;

  if (error) {
    throw new Error(`Error getting instance logs: ${error.message}`);
  }

  return { success: true, data };
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const result = await createInstanceLogCore(body);
    return NextResponse.json(result, { status: 201 });
  } catch (error: any) {
    console.error('Error in instance_logs tool (POST):', error);
    return NextResponse.json(
      { success: false, error: error.message || 'Internal server error' },
      { status: error.message.includes('are required') ? 400 : 500 }
    );
  }
}

export async function GET(request: NextRequest) {
  try {
    const url = new URL(request.url);
    const site_id = url.searchParams.get('site_id');
    const instance_id = url.searchParams.get('instance_id');
    const user_id = url.searchParams.get('user_id');
    const log_type = url.searchParams.get('log_type');
    const level = url.searchParams.get('level');
    const limit = parseInt(url.searchParams.get('limit') || '50');
    const offset = parseInt(url.searchParams.get('offset') || '0');
    
    if (!site_id) {
      return NextResponse.json({ success: false, error: 'site_id is required' }, { status: 400 });
    }

    const result = await listInstanceLogsCore({ 
      site_id, 
      instance_id: instance_id || undefined,
      user_id: user_id || undefined,
      log_type: log_type || undefined,
      level: level || undefined,
      limit,
      offset
    });
    return NextResponse.json(result);
  } catch (error: any) {
    console.error('Error getting instance_logs:', error);
    return NextResponse.json(
      { success: false, error: error.message || 'Internal server error' },
      { status: 500 }
    );
  }
}
