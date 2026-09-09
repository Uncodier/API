import fs from 'fs';
import path from 'path';
import { EmbeddingsService } from './embeddings-service';

export interface SkillMetadata {
  /** Directory name under src/skills (e.g. makinari-rol-frontend). */
  slug: string;
  name: string;
  description: string;
  types?: string[];
  content: string;
}

export class SkillsService {
  private static cachedSkills: SkillMetadata[] | null = null;
  private static cachedSkillEmbeddings: Map<string, number[]> | null = null;
  private static embeddingsInitPromise: Promise<void> | null = null;

  static listSkills(): SkillMetadata[] {
    if (this.cachedSkills) return this.cachedSkills;

    const skillsDirectory = path.join(process.cwd(), 'src', 'skills');
    const skills: SkillMetadata[] = [];

    if (!fs.existsSync(skillsDirectory)) {
      return skills;
    }

    const entries = fs.readdirSync(skillsDirectory, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.isDirectory()) {
        const skillPath = path.join(skillsDirectory, entry.name, 'SKILL.md');
        if (fs.existsSync(skillPath)) {
          const content = fs.readFileSync(skillPath, 'utf8');
          const metadata = this.parseFrontmatter(content);
          if (metadata) {
            skills.push({ ...metadata, slug: entry.name, content });
          }
        }
      }
    }

    this.cachedSkills = skills;
    return skills;
  }

  private static parseFrontmatter(content: string): Omit<SkillMetadata, 'content' | 'slug'> | null {
    const match = content.match(/^---\n([\s\S]*?)\n---/);
    if (!match) return null;

    const frontmatter = match[1];
    const lines = frontmatter.split('\n');
    const result: any = {};

    for (const line of lines) {
      const sepIdx = line.indexOf(':');
      if (sepIdx !== -1) {
        const key = line.substring(0, sepIdx).trim();
        const value = line.substring(sepIdx + 1).trim();

        if (key === 'types') {
          const typeMatch = value.match(/\[(.*?)\]/);
          if (typeMatch) {
            result[key] = typeMatch[1].split(',').map(s => s.trim().replace(/['"]/g, ''));
          }
        } else {
          result[key] = value.replace(/^['"](.*)['"]$/, '$1');
        }
      }
    }

    if (!result.name) return null;

    return {
      name: result.name,
      description: result.description || '',
      types: result.types || []
    };
  }

  static matchSkillsForRequirement(requirementType?: string): SkillMetadata[] {
    const allSkills = this.listSkills();

    if (!requirementType) {
      return allSkills;
    }

    return allSkills.filter(skill => {
      if (!skill.types || skill.types.length === 0) return true;
      return skill.types.includes(requirementType);
    });
  }

  /**
   * Keyword search over name, description, types, and slug (folder).
   * Only searches within skills allowed for this requirement type (same rules as matchSkillsForRequirement).
   */
  static searchSkills(query: string, requirementType?: string): SkillMetadata[] {
    const pool = this.matchSkillsForRequirement(requirementType);
    const q = query.trim().toLowerCase();
    if (!q) return pool;

    const words = q.split(/\s+/).filter(Boolean);
    const scored = pool.map((skill) => {
      const hay = `${skill.name} ${skill.description} ${skill.slug} ${(skill.types || []).join(' ')}`.toLowerCase();
      let score = 0;
      for (const w of words) {
        if (hay.includes(w)) score += 1;
      }
      return { skill, score };
    });

    return scored
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((x) => x.skill);
  }

  /**
   * Initializes skill embeddings in the background if they don't exist.
   */
  private static async initSkillEmbeddings(): Promise<void> {
    if (this.cachedSkillEmbeddings) return;
    if (this.embeddingsInitPromise) return this.embeddingsInitPromise;

    this.embeddingsInitPromise = (async () => {
      try {
        const skills = this.listSkills();
        if (skills.length === 0) {
          this.cachedSkillEmbeddings = new Map();
          return;
        }

        const inputs = skills.map(
          (skill) => `${skill.name}\n${skill.description}\n${(skill.types || []).join(' ')}`
        );

        const { embeddings } = await EmbeddingsService.generateEmbeddings(inputs);

        const map = new Map<string, number[]>();
        for (let i = 0; i < skills.length; i++) {
          if (embeddings[i]) {
            map.set(skills[i].slug, embeddings[i]);
          }
        }
        this.cachedSkillEmbeddings = map;
        console.log(`[SkillsService] Cached vector embeddings for ${map.size} skills.`);
      } catch (e) {
        console.error('[SkillsService] Failed to initialize skill embeddings:', e);
        // Reset promise so it can be retried on next call
        this.embeddingsInitPromise = null;
        throw e;
      }
    })();

    return this.embeddingsInitPromise;
  }

  /**
   * Semantic vector search over skills. Falls back to keyword search on failure.
   */
  static async searchSkillsVector(query: string, requirementType?: string): Promise<SkillMetadata[]> {
    const q = query.trim();
    if (!q) return this.matchSkillsForRequirement(requirementType);

    try {
      await this.initSkillEmbeddings();

      const { embeddings: [queryEmbedding] } = await EmbeddingsService.generateEmbeddings(q);
      if (!queryEmbedding) {
        throw new Error('No embedding returned for query');
      }

      const pool = this.matchSkillsForRequirement(requirementType);
      if (!this.cachedSkillEmbeddings) {
        throw new Error('Skill embeddings not initialized properly');
      }

      const scored = pool.map((skill) => {
        const skillVec = this.cachedSkillEmbeddings!.get(skill.slug);
        const score = skillVec ? EmbeddingsService.cosineSimilarity(queryEmbedding, skillVec) : 0;
        return { skill, score };
      });

      // Filter out low similarity matches and sort by score
      return scored
        .filter((x) => x.score > 0.3) // threshold
        .sort((a, b) => b.score - a.score)
        .map((x) => x.skill);

    } catch (e) {
      console.warn('[SkillsService] Vector search failed, falling back to keyword search:', e);
      return this.searchSkills(q, requirementType);
    }
  }

  /** Resolve by frontmatter name or folder slug (case-insensitive). */
  static getSkillBySlugOrName(nameOrSlug: string): SkillMetadata | null {
    const key = nameOrSlug.trim().toLowerCase();
    if (!key) return null;
    for (const skill of this.listSkills()) {
      if (skill.slug.toLowerCase() === key || skill.name.toLowerCase() === key) {
        return skill;
      }
    }
    return null;
  }

  static skillsToTools(skills: SkillMetadata[]) {
    return skills.map(skill => {
      return {
        name: `skill_${skill.name.replace(/[^a-zA-Z0-9_]/g, '_')}`,
        description: `Read the skill instructions for: ${skill.name}. ${skill.description}`,
        parameters: {
          type: 'object',
          properties: {},
          required: []
        },
        execute: async () => {
          return { content: skill.content };
        }
      };
    });
  }
}
