import { createHash } from 'node:crypto';
import { supabaseAdmin } from '@/lib/database/supabase-server';
import { CreateTaskParams, DbTask } from '@/lib/database/task-db';

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonicalize(v)]));
  }
  return value;
}

/** Stable across retries, including requests without a scheduled date or command ID. */
export function taskCreationKey(task: CreateTaskParams, key?: string, explicitDate = true): string {
  const { command_id, user_id, site_id, lead_id, conversation_id, ...content } = task;
  const identity = key
    ? ['issue-v1', key.trim()]
    : ['content-v1', { ...content, scheduled_date: explicitDate && task.scheduled_date
      ? new Date(task.scheduled_date).toISOString() : undefined }];
  return createHash('sha256').update(JSON.stringify(canonicalize(identity))).digest('hex');
}

/** The database unique index is the concurrency boundary, not a read-before-write check. */
export async function createTaskOnce(task: CreateTaskParams, key?: string, explicitDate = true): Promise<{
  task: DbTask; created: boolean;
}> {
  const creationKey = taskCreationKey(task, key, explicitDate);
  const { data, error } = await supabaseAdmin.from('tasks').insert([{
    ...task,
    creation_key: creationKey,
  }]).select().single();

  if (!error && data) return { task: data, created: true };
  if (error?.code !== '23505') {
    // Fail closed if the migration is missing or persistence failed. Never fall back to an unguarded insert.
    throw new Error(`Error creating task: ${error?.message || 'No task returned'}`);
  }

  const existing = await supabaseAdmin.from('tasks').select('*')
    .eq('site_id', task.site_id).eq('lead_id', task.lead_id).eq('creation_key', creationKey).single();
  if (existing.error || !existing.data) {
    throw new Error(`Error resolving existing task: ${existing.error?.message || 'Task not found'}`);
  }
  // Do not overwrite work in progress (or reopen completed tasks) with a delayed retry.
  return { task: existing.data, created: false };
}