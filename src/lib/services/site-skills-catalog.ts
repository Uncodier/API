import { z } from 'zod';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import type { SkillMetadata } from './skills-service';

export const skillSiteIdSchema = z.string().uuid();
export const skillIdSchema = z.string().uuid();
export const MAX_SKILL_BYTES = 131072;

export class SkillCatalogError extends Error {
  constructor(public readonly code: string, public readonly status: number, message: string) {
    super(message);
    Object.setPrototypeOf(this, SkillCatalogError.prototype);
  }
}

export interface SiteSkill extends SkillMetadata {
  id: string;
  site_id: string;
  source: 'custom' | 'github';
  source_url: string | null;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

/** Only the Agent Skills frontmatter metadata is interpreted; the body is stored verbatim. */
export function parseSkillContent(content: unknown): Pick<SkillMetadata, 'slug' | 'name' | 'description' | 'types' | 'content'> {
  if (typeof content !== 'string' || !content.trim() || Buffer.byteLength(content, 'utf8') > MAX_SKILL_BYTES) {
    throw new SkillCatalogError('invalid_content', 400, 'SKILL.md must be nonempty and at most 128 KiB');
  }
  const frontmatter = content.replace(/^\uFEFF/, '').match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!frontmatter || frontmatter[1].length > 8192) {
    throw new SkillCatalogError('invalid_content', 400, 'SKILL.md requires a frontmatter header');
  }
  const fields = new Map<string, string>();
  const lines = frontmatter[1].split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const match = line.match(/^([a-zA-Z_]+):\s*(.*?)\s*$/);
    // Only the description field supports a literal block; other nested YAML is not interpreted.
    if (!match && line.trim() && !/^#/.test(line.trim())) {
      throw new SkillCatalogError('invalid_content', 400, 'Unsupported skill metadata format');
    }
    if (match && ['name', 'description', 'types'].includes(match[1])) {
      if (fields.has(match[1])) throw new SkillCatalogError('invalid_content', 400, 'Duplicate skill metadata field');
      let value = match[2].replace(/^(['"])(.*)\1$/, '$2');
      if (match[1] === 'description' && /^\|[+-]?$/.test(value)) {
        const chomping = value.slice(1);
        const block: string[] = [];
        let indentation: number | null = null;
        while (index + 1 < lines.length) {
          const next = lines[index + 1];
          if (!next.trim()) { block.push(''); index++; continue; }
          const spaces = next.match(/^( +)\S/);
          if (!spaces || (indentation !== null && spaces[1].length < indentation)) break;
          indentation ??= spaces[1].length;
          block.push(next.slice(indentation));
          index++;
        }
        if (indentation === null) throw new SkillCatalogError('invalid_content', 400, 'Unsupported skill metadata format');
        const text = block.join('\n');
        value = chomping === '-' ? text.replace(/\n+$/, '') :
          chomping === '+' ? `${text}\n` : `${text.replace(/\n+$/, '')}\n`;
      }
      fields.set(match[1], value);
    }
  }
  const name = fields.get('name')?.trim();
  if (!name || name.length > 200 || /[\x00-\x1f]/.test(name)) {
    throw new SkillCatalogError('invalid_content', 400, 'Skill name is required (maximum 200 characters)');
  }
  const description = fields.get('description') ?? '';
  if (description.length > 2000 || /[\x00-\x09\x0b-\x1f]/.test(description)) {
    throw new SkillCatalogError('invalid_content', 400, 'Invalid skill description');
  }
  const typesValue = fields.get('types') || '[]';
  if (!/^\[.*\]$/.test(typesValue)) throw new SkillCatalogError('invalid_content', 400, 'Skill types must be a list');
  const types = typesValue.slice(1, -1).split(',').map(value => value.trim().replace(/^(['"])(.*)\1$/, '$2')).filter(Boolean);
  if (types.length > 20 || types.some(value => !/^[a-z_]{1,50}$/.test(value))) {
    throw new SkillCatalogError('invalid_content', 400, 'Invalid skill types');
  }
  const slug = name.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 100).replace(/-$/, '');
  if (!slug) throw new SkillCatalogError('invalid_content', 400, 'Skill name must contain Latin letters or numbers');
  return { slug, name, description, types, content };
}

function raiseDatabaseError(error: { code?: string } | null) {
  if (!error) return;
  if (error.code === '23505') throw new SkillCatalogError('conflict', 409, 'Skill already exists for this site');
  if (error.code === '23503') throw new SkillCatalogError('invalid_site', 404, 'Site not found');
  throw new SkillCatalogError('database_error', 500, 'Unable to access skills catalog');
}

const columns = 'id, site_id, slug, name, description, types, content, source, source_url, enabled, created_at, updated_at';

export async function listSiteSkills(siteId: string): Promise<SiteSkill[]> {
  skillSiteIdSchema.parse(siteId);
  const { data, error } = await supabaseAdmin.from('site_skills').select(columns).eq('site_id', siteId).order('created_at', { ascending: false });
  raiseDatabaseError(error);
  return (data || []) as SiteSkill[];
}

export async function createSiteSkill(siteId: string, content: string, options: {
  source?: 'custom' | 'github'; sourceUrl?: string; actorId?: string;
} = {}): Promise<SiteSkill> {
  skillSiteIdSchema.parse(siteId);
  const metadata = parseSkillContent(content);
  // Bundled skills are immutable and must not be shadowed by site-specific skills.
  const { SkillsService } = await import('./skills-service');
  if (SkillsService.listSkills().some(skill => skill.slug.toLowerCase() === metadata.slug)) {
    throw new SkillCatalogError('conflict', 409, 'This name is reserved for a system skill');
  }
  const { data, error } = await supabaseAdmin.from('site_skills').insert({
    ...metadata, site_id: siteId, source: options.source ?? 'custom',
    source_url: options.sourceUrl ?? null, created_by: options.actorId ?? null,
  }).select(columns).single();
  raiseDatabaseError(error);
  return data as SiteSkill;
}

export async function updateSiteSkill(siteId: string, id: string, changes: { content?: string; enabled?: boolean }): Promise<SiteSkill> {
  skillSiteIdSchema.parse(siteId);
  skillIdSchema.parse(id);
  if (changes.content === undefined && changes.enabled === undefined) {
    throw new SkillCatalogError('invalid_request', 400, 'content or enabled is required');
  }
  const metadata = changes.content === undefined ? null : parseSkillContent(changes.content);
  if (changes.content !== undefined) {
    const { SkillsService } = await import('./skills-service');
    if (SkillsService.listSkills().some(skill => skill.slug.toLowerCase() === metadata?.slug)) {
      throw new SkillCatalogError('conflict', 409, 'This name is reserved for a system skill');
    }
  }
  const { data, error } = await supabaseAdmin.from('site_skills').update({
    ...(metadata ?? {}), ...(changes.enabled === undefined ? {} : { enabled: changes.enabled }),
    updated_at: new Date().toISOString(),
  })
    .eq('site_id', siteId).eq('id', id).select(columns).maybeSingle();
  raiseDatabaseError(error);
  if (!data) throw new SkillCatalogError('not_found', 404, 'Skill not found');
  return data as SiteSkill;
}

export async function deleteSiteSkill(siteId: string, id: string): Promise<void> {
  skillSiteIdSchema.parse(siteId);
  skillIdSchema.parse(id);
  const { data, error } = await supabaseAdmin.from('site_skills').delete()
    .eq('site_id', siteId).eq('id', id).select('id').maybeSingle();
  raiseDatabaseError(error);
  if (!data) throw new SkillCatalogError('not_found', 404, 'Skill not found');
}