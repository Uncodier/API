/**
 * Merge fields for outbound email / WhatsApp: canonical {{lead.*}} / {{site.*}} tokens,
 * alias normalization for LLM/user typos, and policies for unresolved tokens.
 */

import { supabaseAdmin } from '@/lib/database/supabase-client';
import type { DbLead } from '@/lib/database/lead-db';

const TOKEN_PATTERN = /\{\{([^{}]+)\}\}/g;

/** Canonical paths after normalization (lowercase, single spaces, accents stripped for lookup). */
const LEAD_ALIAS_TO_CANONICAL: Record<string, string> = {
  'lead.full_name': 'lead.name',
  'lead.fullname': 'lead.name',
  'lead.nombre': 'lead.name',
  'lead.display_name': 'lead.name',
  'lead.mail': 'lead.email',
  'lead.correo': 'lead.email',
  'lead.e_mail': 'lead.email',
  'lead.phone_number': 'lead.phone',
  'lead.mobile': 'lead.phone',
  'lead.telefono': 'lead.phone',
  'lead.tel': 'lead.phone',
  'lead.company_name': 'lead.company',
  'lead.empresa': 'lead.company',
  'lead.organization': 'lead.company',
  'lead.org': 'lead.company',
  'lead.job_title': 'lead.position',
  'lead.title': 'lead.position',
  'lead.puesto': 'lead.position',
  'lead.cargo': 'lead.position',
  'site.site_name': 'site.name',
  'site.site': 'site.name',
};

function normalizeInnerPath(inner: string): string {
  return inner
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

/**
 * Rewrites {{ ... }} bodies to canonical paths (lowercase, known aliases → canonical).
 * Does not change non-token text.
 */
export function normalizeMergeTokenSyntax(text: string): string {
  if (!text) return text;
  return text.replace(TOKEN_PATTERN, (_full, inner: string) => {
    const norm = normalizeInnerPath(String(inner));
    const canonical = LEAD_ALIAS_TO_CANONICAL[norm] ?? norm;
    return `{{${canonical}}}`;
  });
}

function companyDisplay(company: DbLead['company']): string {
  if (company == null) return '';
  if (typeof company === 'string') return company;
  const name = (company as Record<string, unknown>).name;
  return typeof name === 'string' ? name : '';
}

function firstNameFromFullName(name: string | null | undefined): string {
  if (!name || typeof name !== 'string') return '';
  const parts = name.trim().split(/\s+/);
  return parts[0] ?? '';
}

function readLeadMetadataPath(lead: DbLead, subPath: string): string {
  const meta = lead.metadata;
  if (!meta || typeof meta !== 'object') return '';
  const parts = subPath.split('.').filter(Boolean);
  let cur: unknown = meta;
  for (const p of parts) {
    if (cur == null || typeof cur !== 'object') return '';
    cur = (cur as Record<string, unknown>)[p];
  }
  if (cur == null) return '';
  if (typeof cur === 'string' || typeof cur === 'number' || typeof cur === 'boolean') {
    return String(cur);
  }
  return '';
}

/**
 * Build flat map for known merge paths from a lead row and optional site display name.
 */
export function buildMergeMapFromLead(lead: DbLead, siteName?: string): Record<string, string> {
  const map: Record<string, string> = {
    'lead.name': lead.name ?? '',
    'lead.first_name': firstNameFromFullName(lead.name),
    'lead.email': lead.email ?? '',
    'lead.phone': lead.phone ?? '',
    'lead.position': lead.position ?? '',
    'lead.company': companyDisplay(lead.company),
    'lead.notes': lead.notes ?? '',
  };
  if (siteName !== undefined && siteName !== '') {
    map['site.name'] = siteName;
  } else {
    map['site.name'] = '';
  }
  return map;
}

export type MergePolicy = 'strip_unresolved' | 'abort_if_unresolved';

export type ContentPlaceholderPolicy = 'strip_tokens' | 'skip_recipient';

export function placeholderPolicyToMergePolicy(p: ContentPlaceholderPolicy | undefined): MergePolicy {
  return p === 'skip_recipient' ? 'abort_if_unresolved' : 'strip_unresolved';
}

export interface ApplyMergeFieldsResult {
  text: string;
  aborted: boolean;
  unresolved: string[];
}

/**
 * Full pipeline: normalize token aliases, then substitute from lead + optional site name.
 * lead.metadata.foo.bar → navigates lead.metadata object.
 */
export function personalizeMergeTemplate(
  text: string,
  lead: DbLead,
  siteName: string | undefined,
  policy: MergePolicy,
): ApplyMergeFieldsResult {
  const normalized = normalizeMergeTokenSyntax(text);
  const map = buildMergeMapFromLead(lead, siteName);
  const unresolved: string[] = [];

  const out = normalized.replace(TOKEN_PATTERN, (_full, inner: string) => {
    const path = normalizeInnerPath(String(inner));
    const canonical = LEAD_ALIAS_TO_CANONICAL[path] ?? path;

    if (canonical.startsWith('lead.metadata.')) {
      const sub = canonical.slice('lead.metadata.'.length);
      return readLeadMetadataPath(lead, sub);
    }

    if (Object.prototype.hasOwnProperty.call(map, canonical)) {
      return map[canonical] ?? '';
    }

    unresolved.push(`{{${canonical}}}`);
    if (policy === 'strip_unresolved') {
      return '';
    }
    return `{{${canonical}}}`;
  });

  if (policy === 'abort_if_unresolved' && unresolved.length > 0) {
    return { text, aborted: true, unresolved };
  }

  return { text: out, aborted: false, unresolved: [] };
}

/**
 * Personalize subject + body together (same policy).
 */
export function personalizeMergeSubjectAndMessage(
  subject: string | undefined,
  message: string,
  lead: DbLead,
  siteName: string | undefined,
  policy: MergePolicy,
): { subject?: string; message: string; aborted: boolean; unresolved: string[] } {
  const subj = subject !== undefined ? personalizeMergeTemplate(subject, lead, siteName, policy) : undefined;
  const msg = personalizeMergeTemplate(message, lead, siteName, policy);
  const aborted = Boolean(subj?.aborted || msg.aborted);
  const unresolved = [...(subj?.unresolved ?? []), ...(msg.unresolved ?? [])];
  if (aborted) {
    return {
      subject: subject,
      message,
      aborted: true,
      unresolved,
    };
  }
  return {
    subject: subj?.text,
    message: msg.text,
    aborted: false,
    unresolved: [],
  };
}

/**
 * Extracts merge tokens from a text and rewrites them to Twilio numbered placeholders
 * ({{1}}, {{2}}, ...). Same canonical token reuses the same index (deduplicated).
 *
 * Returned `tokens` is an ordered array of canonical paths where index i corresponds
 * to placeholder {{i+1}} in the `templated` string.
 */
export function extractMergeTokens(text: string): { templated: string; tokens: string[] } {
  if (!text) return { templated: text, tokens: [] };
  const tokens: string[] = [];
  const seen = new Map<string, number>();

  const templated = text.replace(TOKEN_PATTERN, (_full, inner: string) => {
    const path = normalizeInnerPath(String(inner));
    const canonical = LEAD_ALIAS_TO_CANONICAL[path] ?? path;
    let index = seen.get(canonical);
    if (index === undefined) {
      tokens.push(canonical);
      index = tokens.length;
      seen.set(canonical, index);
    }
    return `{{${index}}}`;
  });

  return { templated, tokens };
}

/**
 * Resolves a single canonical merge token for a given lead.
 * Returns undefined when the token is unknown (caller applies policy).
 */
function resolveCanonicalToken(
  canonical: string,
  lead: DbLead,
  siteName: string | undefined,
): string | undefined {
  if (canonical.startsWith('lead.metadata.')) {
    const sub = canonical.slice('lead.metadata.'.length);
    return readLeadMetadataPath(lead, sub);
  }
  const map = buildMergeMapFromLead(lead, siteName);
  if (Object.prototype.hasOwnProperty.call(map, canonical)) {
    return map[canonical] ?? '';
  }
  return undefined;
}

export interface BuildContentVariablesResult {
  variables: Record<string, string>;
  aborted: boolean;
  unresolved: string[];
}

/**
 * Builds the Twilio `ContentVariables` map for a lead, given the ordered list of
 * canonical tokens that a template expects (same order as placeholders {{1}}..{{N}}).
 *
 * Applies the standard merge policy for unresolved tokens:
 *   - 'strip_unresolved'  -> replaces the value with an empty string.
 *   - 'abort_if_unresolved' -> returns aborted=true and the list of unresolved tokens.
 */
export function buildContentVariablesForLead(
  tokens: string[],
  lead: DbLead,
  siteName: string | undefined,
  policy: MergePolicy,
): BuildContentVariablesResult {
  const variables: Record<string, string> = {};
  const unresolved: string[] = [];

  tokens.forEach((canonical, i) => {
    const placeholderKey = String(i + 1);
    const value = resolveCanonicalToken(canonical, lead, siteName);
    if (value === undefined || value === '') {
      // Unknown canonical path, or known path with empty value.
      if (value === undefined) {
        unresolved.push(`{{${canonical}}}`);
      }
      variables[placeholderKey] = '';
    } else {
      variables[placeholderKey] = value;
    }
  });

  if (policy === 'abort_if_unresolved' && unresolved.length > 0) {
    return { variables, aborted: true, unresolved };
  }

  return { variables, aborted: false, unresolved };
}

/** Site display name for {{site.name}} — one query per send / batch page. */
export async function fetchSiteNameForMerge(siteId: string): Promise<string | undefined> {
  const { data, error } = await supabaseAdmin.from('sites').select('name').eq('id', siteId).maybeSingle();
  if (error || !data?.name) return undefined;
  return typeof data.name === 'string' ? data.name : undefined;
}
