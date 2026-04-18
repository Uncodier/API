import fs from 'fs';
import path from 'path';

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
