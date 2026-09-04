/**
 * Extract MUST NOT / hard constraints from a requirement spec or instructions.
 * Used by executor prompts and the pre-judge constraint gate.
 */

export type RequirementConstraint = {
  text: string;
  forbiddenTerms: string[];
};

const HEADER_RE = /^(#{1,6}\s*)?(hard\s+rules?|critical\s+constraints?|constraints?|restricciones|reglas\s+cr[ií]ticas)\s*:?\s*$/i;
const BULLET_RE = /^\s*(?:[-*]|\d+[.)])\s+/;
const MUST_NOT_RE = /\b(must\s+not|mustn'?t|do\s+not|don't|nunca|sin\s+|solo\s+|only\s+|forbidden|prohibid[oa]|no\s+incluy)/i;

/** Built per-call: ts-jest ESM has emptied module-level lexicon arrays before. */
function outboundLexicon(): string[] {
  return [
    'outbound',
    'prospección en frío',
    'prospecting',
    'cold email',
    'cold-email',
    'cold dm',
    'secuencia de outreach',
    'outreach sequence',
    'cold call',
    'mensaje de prospecci',
    'mensajes de prospecci',
    'dm masivo',
    'mass dm',
  ];
}

function isCommunityOnly(line: string): boolean {
  const l = line.toLowerCase();
  const hasOnly = l.includes('only') || l.includes('solo') || l.includes('solamente');
  const hasCommunity =
    l.includes('comunidad') || l.includes('community') || l.includes('communities') || l.includes('comunidades');
  return hasOnly && hasCommunity;
}

const MENTION_PROHIBITION_RE = /\b(must\s+not\s+mention|do\s+not\s+mention|no\s+mencionar)\b/i;
const COPY_STANDARD_RE = /\bsin copy(\s+comercial)?\b/i;

/** Built per-call: ts-jest ESM has emptied module-level lexicon arrays before. */
function forbiddenTermDenylist(): Set<string> {
  return new Set([
    'http',
    'https',
    'www',
    'url',
    'urls',
    'vertical',
    'verticales',
    'link',
    'links',
    'enlace',
    'enlaces',
    'markdown',
    'docs',
    'file',
    'files',
  ]);
}

function isCopyQualityStandard(line: string): boolean {
  return COPY_STANDARD_RE.test(line);
}

function isMentionProhibition(line: string): boolean {
  return MENTION_PROHIBITION_RE.test(line);
}

function isNegativeConstraint(line: string): boolean {
  const l = line.toLowerCase();
  if (isCopyQualityStandard(l) && !isMentionProhibition(l)) return false;
  return (
    l.includes('must not') ||
    l.includes('do not') ||
    l.includes('nunca') ||
    l.includes('sin ') ||
    l.includes('forbidden') ||
    l.includes('prohibid') ||
    l.includes('no incluy')
  );
}

function expandForbidden(line: string): string[] {
  const raw = String(line || '').trim();
  const lower = raw.toLowerCase();
  const terms: string[] = [];
  const deny = forbiddenTermDenylist();
  const add = (term: string) => {
    const cleaned = String(term || '').trim();
    if (!cleaned) return;
    if (deny.has(cleaned.toLowerCase())) return;
    if (!terms.includes(cleaned)) terms.push(cleaned);
  };
  const lexicon = outboundLexicon();

  const outboundish =
    lexicon.some((term) => lower.includes(term)) ||
    lower.includes('outbound') ||
    isCommunityOnly(raw);
  if (outboundish) {
    for (let i = 0; i < lexicon.length; i++) add(lexicon[i]);
  }

  if (isNegativeConstraint(raw)) {
    const quotes = raw.match(/["']([^"']{2,80})["']/g) || [];
    for (let i = 0; i < quotes.length; i++) {
      add(quotes[i].replace(/["']/g, '').trim());
    }
  }

  if (isMentionProhibition(raw)) {
    const stripped = raw
      .replace(BULLET_RE, '')
      .replace(/^(must not|do not|nunca|sin|no incluy\w*|forbidden|prohibid[oa]|no mencionar)\s+/i, '')
      .replace(/^mention\s+/i, '')
      .trim();
    const words = stripped.split(/[^a-zA-Z0-9_+-]+/);
    for (let i = 0; i < words.length; i++) {
      const word = words[i];
      if (!/^[A-Z][A-Za-z0-9_+-]{2,}$/.test(word)) continue;
      add(word);
    }
  }

  return terms;
}

export function extractRequirementConstraints(...blocks: Array<string | null | undefined>): RequirementConstraint[] {
  const seen = new Set<string>();
  const out: RequirementConstraint[] = [];

  for (const raw of blocks) {
    if (!raw?.trim()) continue;
    const lines = raw.split(/\r?\n/);
    let inConstraintSection = false;
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        if (inConstraintSection) continue;
        continue;
      }
      if (HEADER_RE.test(trimmed)) {
        inConstraintSection = true;
        continue;
      }
      if (inConstraintSection && /^#{1,6}\s/.test(trimmed) && !HEADER_RE.test(trimmed)) {
        inConstraintSection = false;
      }
      const body = trimmed.replace(BULLET_RE, '').trim();
      if (!body) continue;
      const isConstraint = inConstraintSection || MUST_NOT_RE.test(body);
      if (!isConstraint) continue;
      const key = body.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ text: body, forbiddenTerms: expandForbidden(body) });
    }
  }
  return out;
}

export function formatConstraintsPromptBlock(constraints: RequirementConstraint[]): string {
  if (!constraints.length) return '';
  const lines = constraints.map((c) => `- ${c.text}`).join('\n');
  return `
CRITICAL CONSTRAINTS (MUST NOT violate — these override generic marketing playbooks):
${lines}
If a skill suggests something that breaks a constraint above, ignore the skill and obey the constraint.
`;
}

export function findConstraintViolations(
  fileText: string,
  constraints: RequirementConstraint[],
): Array<{ constraint: string; term: string; quote: string }> {
  const hay = fileText.toLowerCase();
  const hits: Array<{ constraint: string; term: string; quote: string }> = [];
  for (const c of constraints) {
    for (const term of c.forbiddenTerms) {
      const idx = hay.indexOf(term.toLowerCase());
      if (idx < 0) continue;
      const start = Math.max(0, idx - 40);
      const quote = fileText.slice(start, idx + term.length + 40).replace(/\s+/g, ' ').trim();
      hits.push({ constraint: c.text, term, quote });
    }
  }
  return hits;
}
