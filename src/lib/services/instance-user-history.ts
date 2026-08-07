import { supabaseAdmin } from '@/lib/database/supabase-client';

export interface UserHistoryConfig {
  maxTotalBytes?: number;
  headN?: number;
  tailN?: number;
  hardCap?: number;
  /** Cap for a single pathological message before measuring/windowing. */
  maxMessageBytes?: number;
}

export interface UserHistoryMessage {
  id: string;
  created_at: string;
  message: string;
  instance_id?: string;
}

export interface UserHistoryResult {
  promptText: string;
  messages: UserHistoryMessage[];
  mode: 'full' | 'windowed' | 'empty';
  totalCount: number;
}

export const USER_HISTORY_DEFAULTS: Required<UserHistoryConfig> = {
  maxTotalBytes: 32 * 1024, // ~32KB
  headN: 5,
  tailN: 10,
  hardCap: 500,
  maxMessageBytes: 16 * 1024, // 16KB per message
};

function byteLen(s: string): number {
  return Buffer.byteLength(s || '', 'utf-8');
}

function clampMessage(message: string, maxBytes: number): string {
  const raw = message || '';
  if (byteLen(raw) <= maxBytes) return raw;
  const head = Buffer.from(raw, 'utf-8').subarray(0, maxBytes - 20).toString('utf-8');
  return `${head}\n... [truncated]`;
}

function formatMessage(msg: UserHistoryMessage): string {
  return `[${new Date(msg.created_at).toISOString()}] User:\n${msg.message}\n\n`;
}

/**
 * Build prompt text from already-fetched user messages (pure — for tests).
 * Fit-all first; when over budget keep first HEAD_N + last TAIL_N.
 */
export function buildUserHistoryPrompt(
  messages: UserHistoryMessage[],
  config?: UserHistoryConfig,
): UserHistoryResult {
  const { maxTotalBytes, headN, tailN, maxMessageBytes } = {
    ...USER_HISTORY_DEFAULTS,
    ...config,
  };

  if (messages.length === 0) {
    return {
      promptText: 'No user messages found.',
      messages: [],
      mode: 'empty',
      totalCount: 0,
    };
  }

  const clamped = messages.map((m) => ({
    ...m,
    message: clampMessage(m.message, maxMessageBytes),
  }));

  let totalBytes = 0;
  for (const msg of clamped) {
    totalBytes += byteLen(msg.message);
  }

  // Fit-all ONLY when under budget. Small counts with huge bodies must window.
  if (totalBytes <= maxTotalBytes) {
    let promptText = '=== USER MESSAGE HISTORY (ALL) ===\n';
    for (const msg of clamped) {
      promptText += formatMessage(msg);
    }
    return {
      promptText: promptText.trim(),
      messages: clamped,
      mode: 'full',
      totalCount: clamped.length,
    };
  }

  // Not enough messages to split? Still window by taking head+tail of what we have
  // (possibly overlapping if count is tiny but bytes are huge — clamp already applied).
  const effectiveHead = Math.min(headN, clamped.length);
  const effectiveTail = Math.min(tailN, Math.max(0, clamped.length - effectiveHead));
  const headMessages = clamped.slice(0, effectiveHead);
  const tailStart = clamped.length - effectiveTail;
  const tailMessages = effectiveTail > 0 ? clamped.slice(Math.max(effectiveHead, tailStart)) : [];
  const middle = clamped.slice(effectiveHead, Math.max(effectiveHead, tailStart));
  const middleCount = middle.length;

  const middleBudget = Math.min(8 * 1024, Math.max(0, maxTotalBytes - 4 * 1024));
  let middleIndex = '';
  let middleUsed = 0;
  for (const msg of middle) {
    const preview = (msg.message || '').replace(/\s+/g, ' ').slice(0, 120);
    const line = `[${new Date(msg.created_at).toISOString()}] ${preview}\n`;
    const lineBytes = byteLen(line);
    if (middleUsed + lineBytes > middleBudget) {
      const shown = middleIndex.split('\n').filter(Boolean).length;
      middleIndex += `…[+${middle.length - shown} more omitted]\n`;
      break;
    }
    middleIndex += line;
    middleUsed += lineBytes;
  }

  // Rebuild under budget: shrink per-message caps until head+tail fit.
  let perMsgBudget = maxMessageBytes;
  let promptText = '';
  for (let attempt = 0; attempt < 4; attempt++) {
    promptText = '=== USER MESSAGE HISTORY (WINDOWED) ===\n\n--- FIRST MESSAGES ---\n';
    for (const msg of headMessages) {
      promptText += formatMessage({ ...msg, message: clampMessage(msg.message, perMsgBudget) });
    }
    if (middleCount > 0) {
      promptText += `\n... [${middleCount} user messages compressed] ...\n`;
      if (middleIndex) {
        promptText += `--- MIDDLE INDEX ---\n${middleIndex}\n`;
      }
    }
    if (tailMessages.length > 0) {
      promptText += '--- LATEST MESSAGES ---\n';
      for (const msg of tailMessages) {
        promptText += formatMessage({ ...msg, message: clampMessage(msg.message, perMsgBudget) });
      }
    }
    if (byteLen(promptText) <= maxTotalBytes + 8 * 1024) break; // allow small overhead for markers
    perMsgBudget = Math.max(500, Math.floor(perMsgBudget / 2));
  }

  return {
    promptText: promptText.trim(),
    messages: clamped,
    mode: 'windowed',
    totalCount: clamped.length,
  };
}

/**
 * Resolve every remote_instance that has touched this requirement
 * (requirement_status rows + runner_instance_id metadata).
 */
export async function resolveRequirementInstanceIds(
  requirementId: string,
  fallbackInstanceId?: string,
): Promise<string[]> {
  const ids = new Set<string>();
  if (fallbackInstanceId) ids.add(fallbackInstanceId);

  const { data: statuses } = await supabaseAdmin
    .from('requirement_status')
    .select('instance_id')
    .eq('requirement_id', requirementId)
    .not('instance_id', 'is', null)
    .limit(50);

  for (const row of statuses || []) {
    if (row.instance_id) ids.add(String(row.instance_id));
  }

  const { data: req } = await supabaseAdmin
    .from('requirements')
    .select('metadata')
    .eq('id', requirementId)
    .maybeSingle();

  const runner = (req?.metadata as Record<string, unknown> | null)?.runner_instance_id;
  if (typeof runner === 'string' && runner) ids.add(runner);

  return Array.from(ids);
}

async function fetchUserActionsForInstances(
  instanceIds: string[],
  hardCap: number,
): Promise<UserHistoryMessage[]> {
  if (instanceIds.length === 0) return [];

  const allMessages: UserHistoryMessage[] = [];
  let page = 0;
  const pageSize = 100;
  let hasMore = true;

  while (hasMore && allMessages.length < hardCap) {
    const start = page * pageSize;
    const end = start + pageSize - 1;

    const { data, error } = await supabaseAdmin
      .from('instance_logs')
      .select('id, created_at, message, instance_id')
      .in('instance_id', instanceIds)
      .eq('log_type', 'user_action')
      .order('created_at', { ascending: true })
      .range(start, end);

    if (error) {
      console.warn(`[UserHistory] Failed to fetch user actions:`, error);
      break;
    }

    if (!data || data.length === 0) {
      hasMore = false;
    } else {
      for (const row of data) {
        allMessages.push({
          id: String(row.id),
          created_at: String(row.created_at),
          message: typeof row.message === 'string' ? row.message : String(row.message ?? ''),
          instance_id: row.instance_id ? String(row.instance_id) : undefined,
        });
      }
      if (data.length < pageSize) {
        hasMore = false;
      } else {
        page++;
      }
    }
  }

  // Dedupe by id (same log shouldn't appear twice) and keep chronological
  const seen = new Set<string>();
  const deduped: UserHistoryMessage[] = [];
  for (const m of allMessages) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    deduped.push(m);
  }
  return deduped.slice(0, hardCap);
}

/**
 * Load paginated user_action history for wrap-up.
 * Prefer requirement-scoped instances (chat + cron builder); fall back to a single instanceId.
 */
export async function loadUserActionHistory(
  instanceId: string,
  config?: UserHistoryConfig & { requirementId?: string },
): Promise<UserHistoryResult> {
  const { hardCap, requirementId } = { ...USER_HISTORY_DEFAULTS, ...config };

  let instanceIds = [instanceId];
  if (requirementId) {
    try {
      instanceIds = await resolveRequirementInstanceIds(requirementId, instanceId);
    } catch (e) {
      console.warn(`[UserHistory] resolveRequirementInstanceIds failed, using runner only:`, e);
    }
  }

  const allMessages = await fetchUserActionsForInstances(instanceIds, hardCap);

  if (allMessages.length >= hardCap) {
    console.warn(
      `[UserHistory] Hard cap of ${hardCap} reached for instances ${instanceIds.join(',').slice(0, 80)}`,
    );
  }

  return buildUserHistoryPrompt(allMessages, config);
}
