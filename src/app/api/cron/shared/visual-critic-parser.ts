import { z } from 'zod';
import type { VisualDefect } from './step-iteration-signals';
import type { VisualCriticResponseFormat } from './visual-critic-client';

export type ParsedVisualCriticVerdict = {
  pass: boolean;
  defects: VisualDefect[];
  summary: string;
};

const categorySchema = z.enum([
  'hierarchy',
  'spacing',
  'typography',
  'color_contrast',
  'responsive',
  'copy',
  'state_missing',
  'broken_visual',
]);
const severitySchema = z.enum(['blocker', 'major', 'minor']);

function normalizedToken(value: unknown): string | unknown {
  return typeof value === 'string'
    ? value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_')
    : value;
}

function normalizeCategory(value: unknown): unknown {
  const token = normalizedToken(value);
  if (typeof token !== 'string') return token;
  const aliases: Record<string, z.infer<typeof categorySchema>> = {
    visual_hierarchy: 'hierarchy',
    layout: 'spacing',
    alignment: 'spacing',
    spacing_alignment: 'spacing',
    colour_contrast: 'color_contrast',
    contrast: 'color_contrast',
    responsiveness: 'responsive',
    mobile: 'responsive',
    content: 'copy',
    copywriting: 'copy',
    missing_state: 'state_missing',
    empty_state: 'state_missing',
    broken: 'broken_visual',
    rendering: 'broken_visual',
  };
  return aliases[token] || token;
}

function normalizeSeverity(value: unknown): unknown {
  const token = normalizedToken(value);
  if (typeof token !== 'string') return token;
  const aliases: Record<string, z.infer<typeof severitySchema>> = {
    critical: 'blocker',
    severe: 'blocker',
    high: 'major',
    medium: 'major',
    moderate: 'major',
    low: 'minor',
    info: 'minor',
  };
  return aliases[token] || token;
}

const strictDefectSchema = z.object({
  category: categorySchema,
  severity: severitySchema,
  route: z.string().min(1),
  viewport: z.string().min(1),
  description: z.string().max(400),
  fix_hint: z.string().max(400).nullable(),
}).strict();

const strictVerdictSchema = z.object({
  pass: z.boolean(),
  summary: z.string().max(400),
  defects: z.array(strictDefectSchema).max(3),
}).strict();

const fallbackDefectSchema = z.object({
  category: z.preprocess(normalizeCategory, categorySchema),
  severity: z.preprocess(normalizeSeverity, severitySchema),
  route: z.string().refine((value) => value.trim().length > 0),
  viewport: z.string().refine((value) => value.trim().length > 0),
  description: z.string().refine((value) => value.trim().length > 0),
  fix_hint: z.string().nullable().optional(),
}).strip();

const fallbackVerdictSchema = z.object({
  pass: z.boolean(),
  summary: z.string(),
  defects: z.array(fallbackDefectSchema).max(3),
}).strip();

function unwrapFallbackVerdict(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.length === 1 ? unwrapFallbackVerdict(value[0]) : value;
  }
  if (!value || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  if ('pass' in record && 'defects' in record) return record;
  for (const key of ['verdict', 'result', 'data', 'output', 'results']) {
    if (key in record) return unwrapFallbackVerdict(record[key]);
  }
  return value;
}

function extractFirstJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index++) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') depth++;
    else if (char === '}' && --depth === 0) {
      return text.slice(start, index + 1);
    }
  }
  return null;
}

function parseJsonObject(text: string): unknown | null {
  let raw = text.trim();
  const fenceMatch = raw.match(/^```(?:json)?\s*([\s\S]*?)```\s*$/i);
  if (fenceMatch) raw = fenceMatch[1].trim();
  try {
    return JSON.parse(raw);
  } catch {
    const candidate = extractFirstJsonObject(raw);
    if (!candidate) return null;
    try {
      return JSON.parse(candidate);
    } catch {
      return null;
    }
  }
}

function derivePass(defects: VisualDefect[]): boolean {
  const blockers = defects.filter(
    (defect) => defect.severity === 'blocker',
  ).length;
  const majors = defects.filter(
    (defect) => defect.severity === 'major',
  ).length;
  return blockers === 0 && majors < 2;
}

export function parseVisualCriticVerdict(
  text: string,
  responseFormat: VisualCriticResponseFormat = 'json_schema',
): ParsedVisualCriticVerdict | null {
  if (!text) return null;
  const parsed = parseJsonObject(text);
  if (parsed === null) return null;
  const validated = responseFormat === 'json_object'
    ? fallbackVerdictSchema.safeParse(unwrapFallbackVerdict(parsed))
    : strictVerdictSchema.safeParse(parsed);
  if (!validated.success) return null;

  const defects: VisualDefect[] = validated.data.defects.map((defect) => ({
    category: defect.category,
    severity: defect.severity,
    route: defect.route,
    viewport: defect.viewport,
    description: defect.description.slice(0, 400),
    ...(typeof defect.fix_hint === 'string' && defect.fix_hint
      ? { fix_hint: defect.fix_hint.slice(0, 400) }
      : {}),
  }));
  return {
    pass: derivePass(defects),
    defects,
    summary: validated.data.summary.slice(0, 400),
  };
}
