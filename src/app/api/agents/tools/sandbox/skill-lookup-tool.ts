import { SkillsService } from '@/lib/services/skills-service';

export type SkillLookupToolContext = {
  /** When set, list/search only include skills applicable to this requirement type (see SKILL.md types). */
  requirement_type?: string;
};

function summarizeForList(
  skills: ReturnType<typeof SkillsService.matchSkillsForRequirement>,
  limit: number,
) {
  return skills.slice(0, limit).map((s) => ({
    name: s.name,
    slug: s.slug,
    description: s.description,
    types: s.types ?? [],
  }));
}

/**
 * Single on-demand tool to list, search, or load full SKILL.md bodies (replaces many per-skill tools).
 */
export function skillLookupTool(ctx?: SkillLookupToolContext) {
  const requirementType = ctx?.requirement_type;

  return {
    name: 'skill_lookup',
    description:
      'Browse and load Agent Skills (SKILL.md procedures) on demand. At the start of work, call action=search with keywords from your objective (or action=list). Use action=get with skill_name from results to read the full skill body before implementing. Searches are scoped to skills relevant to this requirement when requirement type is known.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'search', 'get'],
          description:
            'list: compact catalog (metadata only). search: filter by keywords. get: full SKILL.md content for one skill.',
        },
        query: {
          type: 'string',
          description: 'Required for search: space-separated keywords (e.g. "next seo landing").',
        },
        skill_name: {
          type: 'string',
          description:
            'Required for get: skill name or folder slug from list/search (e.g. makinari-rol-frontend).',
        },
        limit: {
          type: 'number',
          description: 'Max entries for list/search (default 20, max 40).',
        },
      },
      required: ['action'],
    },
    execute: async (args: {
      action: 'list' | 'search' | 'get';
      query?: string;
      skill_name?: string;
      limit?: number;
    }) => {
      const limit = Math.min(Math.max(args.limit ?? 20, 1), 40);

      if (args.action === 'list') {
        const pool = SkillsService.matchSkillsForRequirement(requirementType);
        return {
          ok: true,
          requirement_type_filter: requirementType ?? null,
          count: pool.length,
          skills: summarizeForList(pool, limit),
          hint: 'Use action=search with query matching your task, then action=get with skill_name to load instructions.',
        };
      }

      if (args.action === 'search') {
        const q = (args.query ?? '').trim();
        if (!q) {
          return { ok: false, error: 'query is required for search (e.g. your objective or tech stack).' };
        }
        const matches = SkillsService.searchSkills(q, requirementType);
        return {
          ok: true,
          query: q,
          requirement_type_filter: requirementType ?? null,
          count: matches.length,
          skills: summarizeForList(matches, limit),
          hint: 'Call action=get with skill_name set to name or slug from skills[].',
        };
      }

      const key = (args.skill_name ?? '').trim();
      if (!key) {
        return { ok: false, error: 'skill_name is required for get.' };
      }

      const skill = SkillsService.getSkillBySlugOrName(key);
      if (!skill) {
        return { ok: false, error: `No skill found for "${key}". Use skill_lookup search or list first.` };
      }

      const pool = SkillsService.matchSkillsForRequirement(requirementType);
      const inScope = pool.some((s) => s.slug === skill.slug);
      const scopeNote = !inScope
        ? ' Note: this skill is outside the usual filter for this requirement type — use only if appropriate.'
        : '';

      return {
        ok: true,
        name: skill.name,
        slug: skill.slug,
        description: skill.description,
        types: skill.types ?? [],
        content: skill.content,
        message: `Full SKILL.md loaded for "${skill.name}".${scopeNote}`,
      };
    },
  };
}
