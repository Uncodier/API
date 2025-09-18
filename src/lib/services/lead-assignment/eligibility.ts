import { supabaseAdmin } from '@/lib/database/supabase-client';

type ProfileRecord = {
  id: string;
  role?: string | null;
  metadata?: Record<string, unknown> | null;
};

const ALLOWED_SALES_ROLES = new Set([
  'sales_agent',
  'sales',
  'seller',
  'vendedor',
  'sdr',
  'bdr'
]);

const EXCLUDED_KEYWORDS = [
  'external',
  'externo',
  'consultant',
  'consultor',
  'contractor',
  'freelance',
  'freelancer',
  'vendor',
  'collaborator',
  'colaborador',
  'third-party',
  'terceros',
  'outsourced',
  'outsourcing'
];

function normalize(value?: string | null): string {
  return (value || '').toString().trim().toLowerCase();
}

export function isProfileEligibleForLeadAssignment(profile: ProfileRecord | null | undefined): boolean {
  if (!profile) return false;

  const role = normalize(profile.role);

  // Immediate allow if explicit allowed role
  if (role && ALLOWED_SALES_ROLES.has(role)) return true;

  // Immediate exclude if role includes excluded keywords
  if (role && EXCLUDED_KEYWORDS.some(k => role.includes(k))) return false;

  // Inspect metadata for signals
  const metadata = (profile.metadata || {}) as Record<string, unknown>;
  const metaRole = normalize(String((metadata as any).role || (metadata as any).job_role || (metadata as any).title));

  if (metaRole) {
    if (ALLOWED_SALES_ROLES.has(metaRole)) return true;
    if (EXCLUDED_KEYWORDS.some(k => metaRole.includes(k))) return false;
  }

  // Default: not eligible unless clearly sales-oriented
  return false;
}

export async function fetchEligibleMemberIds(siteId: string): Promise<string[]> {
  // 1) Get active site members
  const { data: siteMembers, error: membersError } = await supabaseAdmin
    .from('site_members')
    .select('user_id, role, status')
    .eq('site_id', siteId)
    .eq('status', 'active');

  if (membersError || !siteMembers || siteMembers.length === 0) {
    return [];
  }

  // 2) Load profiles for those IDs
  const userIds = siteMembers.map(m => m.user_id);

  const { data: profiles, error: profilesError } = await supabaseAdmin
    .from('profiles')
    .select('id, role, metadata')
    .in('id', userIds);

  if (profilesError || !profiles) {
    return [];
  }

  // 3) Filter out external/collaborators and keep sales roles only
  const eligible = profiles.filter(p => isProfileEligibleForLeadAssignment(p));
  return eligible.map(p => p.id);
}


