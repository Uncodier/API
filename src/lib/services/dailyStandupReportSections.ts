import { z } from 'zod';
import { supabaseAdmin } from '@/lib/database/supabase-client';

export const REPORT_SECTIONS = [
  'sales', 'tasks', 'requirements', 'social', 'channels',
  'records', 'orders', 'reservations', 'inventory',
] as const;

export type ReportSection = typeof REPORT_SECTIONS[number];
export const reportSectionsSchema = z.array(z.enum(REPORT_SECTIONS));

export const REPORT_SECTION_LABELS: Record<ReportSection, string> = {
  sales: 'Sales', tasks: 'Tasks', requirements: 'Requirements', social: 'Social',
  channels: 'Channels', records: 'Records', orders: 'Orders',
  reservations: 'Reservations', inventory: 'Inventory',
};

/** Only absence gets the legacy default. Any malformed selection fails closed. */
export function normalizeReportSections(value: unknown): ReportSection[] {
  if (value === undefined) return [...REPORT_SECTIONS];
  const parsed = reportSectionsSchema.safeParse(value);
  if (!parsed.success) return [];
  return REPORT_SECTIONS.filter(section => parsed.data.includes(section));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function persistedReportSections(activities: unknown): ReportSection[] {
  if (activities === undefined || activities === null) return [...REPORT_SECTIONS];
  if (!isObject(activities)) return [];
  const activity = activities.daily_resume_and_stand_up;
  if (activity === undefined) return [...REPORT_SECTIONS];
  // Legacy settings stored just a status string, with no report_sections field.
  if (activity === 'active' || activity === 'inactive') return [...REPORT_SECTIONS];
  if (!isObject(activity)) return [];
  return normalizeReportSections(activity.report_sections);
}

export async function getLatestDailyStandupSettings(siteId: string) {
  const { data, error } = await supabaseAdmin.from('settings')
    .select('activities,business_hours').eq('site_id', siteId)
    .order('created_at', { ascending: false }).limit(1);
  // A failed read must never become the missing-field default.
  if (error) throw new Error('Could not retrieve Daily Standup report settings');
  return data?.[0] || null;
}

export async function getLatestReportSections(siteId: string): Promise<ReportSection[]> {
  const settings = await getLatestDailyStandupSettings(siteId);
  return persistedReportSections(settings?.activities);
}

export function constrainReportSections(persisted: ReportSection[], requested: unknown): ReportSection[] {
  const requestedSections = normalizeReportSections(requested);
  return persisted.filter(section => requestedSections.includes(section));
}