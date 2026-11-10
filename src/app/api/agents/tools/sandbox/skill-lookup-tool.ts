import { SkillsService } from '@/lib/services/skills-service';
import { searchSkillsByKeywords } from '@/lib/services/skill-keyword-search';
import { deductSandboxToolCredits, type SandboxToolsContext } from '@/app/api/agents/tools/sandbox/assistantProtocol';

export type SkillLookupToolContext = {
  /** When set, list/search only include skills applicable to this requirement type (see SKILL.md types). */
  requirement_type?: string;
  /** Pass toolsCtx to deduct credits */
  toolsCtx?: SandboxToolsContext;
  /** Tenant scope for user-uploaded skills. Never derive this from tool arguments. */
  siteId?: string;
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
      'Browse and load Agent Skills (SKILL.md procedures) on demand. Recommended flow: (1) action=search with a natural language description of what you want to achieve or 3-10 concise English keywords from objective, stack, domain, and deliverable. (2) action=get for top skill_name candidates. (3) action=list only when discovery is unclear. Current categories (frontmatter types): develop, automation, content, design, task, integration, planning, research, marketing_campaign, optimization, strategy. When requirement_type is known, list/search are automatically scoped to that type.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'search', 'get'],
          description:
            'list: compact catalog (metadata only). search: tenant-scoped keyword matching, or semantic search without a tenant scope. get: full SKILL.md content for one skill.',
        },
        query: {
          type: 'string',
          description:
            'Required for search. Use concise keywords from objective + stack + output. English works across the catalog; bilingual descriptions also support Spanish, accents, 2D and 3D (e.g. "animación explicativo HTML 3D").',
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
      const creditCheck = await deductSandboxToolCredits(ctx?.toolsCtx, 'skill_lookup', args);
      if (!creditCheck.success) {
        return { ok: false, error: creditCheck.error };
      }

      const limit = Math.min(Math.max(args.limit ?? 20, 1), 40);

      if (args.action === 'list') {
        const pool = ctx?.siteId
          ? await SkillsService.listSkillsForSite(ctx.siteId, requirementType)
          : SkillsService.matchSkillsForRequirement(requirementType);
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
        const matches = ctx?.siteId
          ? searchSkillsByKeywords(await SkillsService.listSkillsForSite(ctx.siteId, requirementType), q)
          : await SkillsService.searchSkillsVector(q, requirementType);
        return {
          ok: true,
          query: q,
          requirement_type_filter: requirementType ?? null,
          count: matches.length,
          skills: summarizeForList(matches, limit),
          hint:
            matches.length > 0
              ? 'Call action=get with skill_name set to name or slug from skills[].'
              : 'No matches found. Retry action=search with different terms, or call action=list to inspect available categories/types before selecting a skill.',
        };
      }

      const key = (args.skill_name ?? '').trim();
      if (!key) {
        return { ok: false, error: 'skill_name is required for get.' };
      }

      const skill = ctx?.siteId
        ? await SkillsService.getSkillBySlugForSite(ctx.siteId, key)
        : SkillsService.getSkillBySlugOrName(key);
      if (!skill) {
        return { ok: false, error: `No skill found for "${key}". Use skill_lookup search or list first.` };
      }

      const pool = ctx?.siteId
        ? await SkillsService.listSkillsForSite(ctx.siteId, requirementType)
        : SkillsService.matchSkillsForRequirement(requirementType);
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
