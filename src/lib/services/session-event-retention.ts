import type { SupabaseClient } from '@supabase/supabase-js';
import { supabaseAdmin } from '@/lib/database/supabase-client';

export const SESSION_EVENT_RETENTION_DAYS = 30;
export const SESSION_EVENT_RETENTION_EXEMPT_PLANS = new Set(['foundry', 'reactor']);

const BILLING_PAGE_SIZE = 1_000;
const EVENT_BATCH_SIZE = 500;
const DELETE_BATCH_SIZE = 100;
const STORAGE_BATCH_SIZE = 100;
const MAX_EVENTS_PER_RUN = 5_000;

interface BillingRow {
  id: string;
  site_id: string | null;
  plan: string | null;
  updated_at: string | null;
}

interface SessionEventRow {
  id: string;
  event_type: string;
  properties: unknown;
}

export interface SessionEventRetentionResult {
  cutoff: string;
  protectedSites: number;
  scannedEvents: number;
  deletedEvents: number;
  deletedRecordingObjects: number;
  storageErrors: number;
  hasMore: boolean;
}

function chunks<T>(values: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

export function getRecordingPaths(properties: unknown): string[] {
  if (!properties || typeof properties !== 'object') return [];
  const rawChunks = (properties as { chunks?: unknown }).chunks;
  if (!Array.isArray(rawChunks)) return [];
  return rawChunks.filter((path): path is string => typeof path === 'string' && path.length > 0);
}

export function selectProtectedSiteIds(rows: BillingRow[]): string[] {
  const currentPlanBySite = new Map<string, string>();

  for (const row of rows) {
    if (!row.site_id || currentPlanBySite.has(row.site_id)) continue;
    currentPlanBySite.set(row.site_id, row.plan?.trim().toLowerCase() || '');
  }

  return Array.from(currentPlanBySite.entries())
    .filter(([, plan]) => SESSION_EVENT_RETENTION_EXEMPT_PLANS.has(plan))
    .map(([siteId]) => siteId);
}

async function loadProtectedSiteIds(client: SupabaseClient): Promise<string[]> {
  const rows: BillingRow[] = [];

  for (let from = 0; ; from += BILLING_PAGE_SIZE) {
    const { data, error } = await client
      .from('billing')
      .select('id, site_id, plan, updated_at')
      .not('site_id', 'is', null)
      .order('updated_at', { ascending: false, nullsFirst: false })
      .order('id', { ascending: false })
      .range(from, from + BILLING_PAGE_SIZE - 1);

    if (error) throw new Error(`Could not load billing plans: ${error.message}`);
    const page = (data || []) as BillingRow[];
    rows.push(...page);
    if (page.length < BILLING_PAGE_SIZE) break;
  }

  return selectProtectedSiteIds(rows);
}

async function loadExpiredEvents(
  client: SupabaseClient,
  cutoff: string,
  protectedSiteIds: string[],
): Promise<SessionEventRow[]> {
  let query = client
    .from('session_events')
    .select('id, event_type, properties')
    .lt('created_at', cutoff)
    .order('created_at', { ascending: true })
    .limit(EVENT_BATCH_SIZE);

  if (protectedSiteIds.length > 0) {
    query = query.or(`site_id.is.null,site_id.not.in.(${protectedSiteIds.join(',')})`);
  }

  const { data, error } = await query;
  if (error) throw new Error(`Could not load expired session events: ${error.message}`);
  return (data || []) as SessionEventRow[];
}

async function removeRecordingObjects(
  client: SupabaseClient,
  events: SessionEventRow[],
): Promise<{ failedEventIds: Set<string>; deletedObjects: number; errors: number }> {
  const ownerByPath = new Map<string, Set<string>>();

  for (const event of events) {
    if (event.event_type !== 'session_recording') continue;
    for (const path of getRecordingPaths(event.properties)) {
      const owners = ownerByPath.get(path) || new Set<string>();
      owners.add(event.id);
      ownerByPath.set(path, owners);
    }
  }

  const failedEventIds = new Set<string>();
  let deletedObjects = 0;
  let errors = 0;

  for (const pathBatch of chunks(Array.from(ownerByPath.keys()), STORAGE_BATCH_SIZE)) {
    const { error } = await client.storage.from('session_recordings').remove(pathBatch);
    if (!error) {
      deletedObjects += pathBatch.length;
      continue;
    }

    errors += 1;
    for (const path of pathBatch) {
      ownerByPath.get(path)?.forEach((eventId) => failedEventIds.add(eventId));
    }
    console.error('[SessionEventRetention] Could not remove recording objects:', error);
  }

  return { failedEventIds, deletedObjects, errors };
}

async function deleteEvents(client: SupabaseClient, eventIds: string[]): Promise<number> {
  let deleted = 0;

  for (const idBatch of chunks(eventIds, DELETE_BATCH_SIZE)) {
    const { data, error } = await client
      .from('session_events')
      .delete()
      .in('id', idBatch)
      .select('id');

    if (error) throw new Error(`Could not delete expired session events: ${error.message}`);
    deleted += data?.length || 0;
  }

  return deleted;
}

export async function runSessionEventRetention(
  client: SupabaseClient = supabaseAdmin,
  now = new Date(),
): Promise<SessionEventRetentionResult> {
  const cutoff = new Date(
    now.getTime() - SESSION_EVENT_RETENTION_DAYS * 24 * 60 * 60 * 1_000,
  ).toISOString();
  const protectedSiteIds = await loadProtectedSiteIds(client);

  let scannedEvents = 0;
  let deletedEvents = 0;
  let deletedRecordingObjects = 0;
  let storageErrors = 0;
  let hasMore = false;

  while (scannedEvents < MAX_EVENTS_PER_RUN) {
    const events = await loadExpiredEvents(client, cutoff, protectedSiteIds);
    if (events.length === 0) {
      hasMore = false;
      break;
    }

    scannedEvents += events.length;
    hasMore = events.length === EVENT_BATCH_SIZE;

    const storageResult = await removeRecordingObjects(client, events);
    deletedRecordingObjects += storageResult.deletedObjects;
    storageErrors += storageResult.errors;

    const deletableIds = events
      .filter((event) => !storageResult.failedEventIds.has(event.id))
      .map((event) => event.id);

    if (deletableIds.length === 0) break;
    deletedEvents += await deleteEvents(client, deletableIds);

    if (events.length < EVENT_BATCH_SIZE) {
      hasMore = false;
      break;
    }
  }

  return {
    cutoff,
    protectedSites: protectedSiteIds.length,
    scannedEvents,
    deletedEvents,
    deletedRecordingObjects,
    storageErrors,
    hasMore,
  };
}
