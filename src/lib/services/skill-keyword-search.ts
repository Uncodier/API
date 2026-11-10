type SearchableSkill = {
  name: string;
  slug: string;
  description: string;
  types?: string[];
};

// Keep meaningful short stack/domain terms without matching every Spanish article.
const SHORT_TECHNICAL_TERMS = new Set(['2d', '3d', 'ui', 'ux', 'qa', 'ai', 'js', 'ts', 'db']);

function normalize(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

/** Rank only the caller's authorized pool; never load or broaden a catalog here. */
export function searchSkillsByKeywords<T extends SearchableSkill>(skills: T[], query: string): T[] {
  const words = [...new Set(normalize(query).split(/[^a-z0-9_-]+/)
    .filter(word => word.length > 2 || SHORT_TECHNICAL_TERMS.has(word)))];
  if (!words.length) return [];
  return skills.map(skill => {
    const haystack = normalize(`${skill.name} ${skill.description} ${skill.slug} ${(skill.types ?? []).join(' ')}`);
    return { skill, score: words.reduce((score, word) => score + Number(haystack.includes(word)), 0) };
  }).filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score).map(({ skill }) => skill);
}