/**
 * Vision-model "design reviewer" — takes step screenshots produced by
 * runVisualProbe, sends them to a vision-capable model with a strict JSON
 * schema, and returns a VisualSignal enriched with pass/defects.
 *
 * Uses the configured AI provider with a dedicated low-cost visual model when
 * available. Failures are reported as skipped so infrastructure outages do
 * not consume a product retry.
 */

import type { VisualSignal, VisualDefect } from './step-iteration-signals';
import { fetchVisualScreenshotDataUrl } from './visual-screenshot-data';
import { requestVisualCriticCompletion } from './visual-critic-client';

const DEFAULT_TIMEOUT_MS = 45_000;
const DEFAULT_MAX_SCREENSHOTS = 2;
const MAX_SCREENSHOTS_PER_CALL = 2;

export type VisualCriticInput = {
  screenshots: Array<{ route: string; viewport: string; url: string }>;
  step: { order: number; title?: string; instructions?: string; expected_output?: string };
  rubric?: string;
  brand_context?: string;
  requirementId?: string;
  model?: string;
  timeoutMs?: number;
  maxScreenshots?: number;
};

export type VisualCriticResult = {
  pass: boolean;
  defects: VisualDefect[];
  summary: string;
  model_used?: string;
  /** When the critic could not run (env missing, network failure, bad parse, etc.). */
  skipped?: string;
};

const DEFAULT_RUBRIC = `
Evaluate each screenshot for delivery-quality UI. Be strict but fair:
1. Visual hierarchy: clear primary action, scannable sections, consistent weight/scale.
2. Spacing & alignment: even paddings, no cramped or awkward gaps, aligned grids.
3. Typography: size ramp, readable line height, limited font families, no clipping.
4. Color & contrast: AA contrast, consistent palette, usable hover/active when visible.
5. Responsive: on mobile viewport nothing overflows, touch targets reasonable.
6. Copy quality: real human copy (not lorem), no obvious placeholder, no runaway asterisks/"TODO".
7. State coverage: empty / loaded states look intentional, hero has real content.
8. Broken visuals: missing images (broken URLs), overlapping elements, stacking glitches.
Severities:
- blocker: page unusable, major broken visual, unreadable, wrong content
- major: obvious design issue a reviewer would flag in a PR
- minor: nitpicks, polish
`.trim();

export function resolveVisualCriticModel(
  requestedModel?: string,
  env: Record<string, string | undefined> = process.env,
): string {
  if (requestedModel?.trim()) return requestedModel.trim();
  if (env.AI_VISUAL_MODEL?.trim()) return env.AI_VISUAL_MODEL.trim();
  const provider = (env.AI_PROVIDER || 'gemini').toLowerCase();
  if (provider === 'gemini') return 'gemini-2.5-flash';
  if (provider === 'openai') return 'gpt-4o-mini';
  if (provider === 'azure') {
    return (
      env.AI_VISUAL_AZURE_DEPLOYMENT ||
      env.MICROSOFT_AZURE_OPENAI_DEPLOYMENT ||
      env.AI_MODEL ||
      'gpt-4o'
    );
  }
  if (provider === 'xai') {
    return (
      env.AI_MODEL ||
      (env.GOOGLE_CLOUD_PROJECT_ID && !env.XAI_API_KEY
        ? 'xai/grok-4.6'
        : 'grok-4.6')
    );
  }
  return 'gemini-2.5-flash';
}

export async function runVisualCritic(input: VisualCriticInput): Promise<VisualCriticResult> {
  if (!input.screenshots.length) {
    return { pass: true, defects: [], summary: 'no screenshots to evaluate', skipped: 'no_screenshots' };
  }
  if (!input.requirementId) {
    return {
      pass: true,
      defects: [],
      summary: 'visual critic requires requirement-scoped screenshots',
      skipped: 'missing_requirement_context',
    };
  }

  const rubric = (input.rubric || DEFAULT_RUBRIC).slice(0, 4_000);
  const timeout = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxScreenshots = Math.max(
    1,
    Math.min(6, input.maxScreenshots ?? DEFAULT_MAX_SCREENSHOTS),
  );
  const screenshots = input.screenshots.slice(0, maxScreenshots);
  const resolvedModel = resolveVisualCriticModel(input.model);
  const allDefects: VisualDefect[] = [];
  const summaries: string[] = [];
  let finalSkipped: string | undefined;
  let finalModelUsed = resolvedModel;
  const abortController = new AbortController();
  let timedOut = false;
  const timeoutHandle = setTimeout(() => {
    timedOut = true;
    abortController.abort();
  }, timeout);

  // Process in batches of MAX_SCREENSHOTS_PER_CALL
  try {
    for (let i = 0; i < screenshots.length; i += MAX_SCREENSHOTS_PER_CALL) {
      if (abortController.signal.aborted) {
        finalSkipped = 'timeout';
        summaries.push(`Visual critic exceeded its ${timeout}ms total deadline.`);
        break;
      }
    const batch = screenshots.slice(i, i + MAX_SCREENSHOTS_PER_CALL);
    
    const systemPrompt = [
      'You are a senior product designer reviewing the UI of a step committed by a coding agent.',
      'Output STRICT JSON only — no prose, no markdown fences. The JSON shape is:',
      '{',
      '  "pass": boolean,',
      '  "summary": string (1-2 sentences),',
      '  "defects": Array<{',
      '    "category": "hierarchy" | "spacing" | "typography" | "color_contrast" | "responsive" | "copy" | "state_missing" | "broken_visual",',
      '    "severity": "blocker" | "major" | "minor",',
      '    "route": string,',
      '    "viewport": string,',
      '    "description": string,',
      '    "fix_hint": string',
      '  }>',
      '}',
      'Rules: pass=false when there is at least one blocker or two+ majors. Always fill route and viewport from the image metadata header.',
      'Return at most 3 defects, ordered by severity and impact. Ignore cosmetic nitpicks that do not affect delivery quality.',
      'Rubric:',
      rubric,
    ].join('\n');

    const userBlocks: Array<
      | { type: 'text'; text: string }
      | { type: 'image_url'; image_url: { url: string; detail: 'low' } }
    > = [];
    userBlocks.push({
      type: 'text',
      text: [
        input.step.order !== undefined ? `Step ${input.step.order}${input.step.title ? `: ${input.step.title.slice(0, 200)}` : ''}` : (input.step.title ? `Step: ${input.step.title.slice(0, 200)}` : 'Step evaluation'),
        input.step.instructions ? `Instructions: ${input.step.instructions.slice(0, 600)}` : '',
        input.step.expected_output ? `Expected output: ${input.step.expected_output.slice(0, 400)}` : '',
        input.brand_context ? `Brand context: ${input.brand_context.slice(0, 400)}` : '',
        '',
        `Screenshots follow (Batch ${Math.floor(i / MAX_SCREENSHOTS_PER_CALL) + 1} of ${Math.ceil(screenshots.length / MAX_SCREENSHOTS_PER_CALL)}). Each is preceded by its route + viewport metadata.`,
      ]
        .filter(Boolean)
        .join('\n'),
    });

    let imagesAdded = 0;
    for (const s of batch) {
      userBlocks.push({ type: 'text', text: `route="${s.route}" viewport="${s.viewport}"` });
      const dataUrl = await fetchVisualScreenshotDataUrl(s.url, {
        requirementId: input.requirementId,
        signal: abortController.signal,
      });
      if (dataUrl) {
        userBlocks.push({
          type: 'image_url',
          image_url: { url: dataUrl, detail: 'low' },
        });
        imagesAdded++;
      } else {
        console.warn(`[VisualCritic] Screenshot unavailable: ${s.route} (${s.viewport})`);
      }
    }

    if (imagesAdded !== batch.length) {
      finalSkipped =
        timedOut
          ? 'timeout'
          : imagesAdded === 0
            ? 'screenshots_unavailable'
            : 'screenshots_incomplete';
      summaries.push(
        `Batch ${Math.floor(i / MAX_SCREENSHOTS_PER_CALL) + 1} loaded ${imagesAdded}/${batch.length} screenshots.`,
      );
      if (timedOut) break;
      continue;
    }

    let rawText = '';
    try {
      const response = await requestVisualCriticCompletion({
        model: resolvedModel,
        system: systemPrompt,
        content: userBlocks,
        signal: abortController.signal,
      });
      finalModelUsed = response.model;
      rawText = response.text;

      const parsed = safeParseVerdict(rawText);
      if (!parsed) {
        finalSkipped = 'parse_error';
        summaries.push(`Batch ${Math.floor(i / MAX_SCREENSHOTS_PER_CALL) + 1} parse error.`);
        continue;
      }

      allDefects.push(...parsed.defects);
      if (parsed.summary) summaries.push(parsed.summary);

    } catch (e: unknown) {
      const msg = timedOut
        ? `Timeout of ${timeout}ms exceeded`
        : e instanceof Error
          ? e.message
          : String(e);
      finalSkipped = 'request_failed';
      summaries.push(`Batch ${Math.floor(i / MAX_SCREENSHOTS_PER_CALL) + 1} failed: ${msg.slice(0, 100)}`);
      if (timedOut) break;
    }
    }
  } finally {
    clearTimeout(timeoutHandle);
  }

  // Any incomplete batch marks the critic unavailable. The caller retries the
  // infrastructure instead of accepting a partial visual review.
  const finalSummary = summaries.join(' | ').slice(0, 400) || (finalSkipped ? `visual critic skipped — ${finalSkipped}` : 'No summary provided');
  const blockers = allDefects.filter((defect) => defect.severity === 'blocker').length;
  const majors = allDefects.filter((defect) => defect.severity === 'major').length;

  return {
    pass: blockers === 0 && majors < 2,
    defects: allDefects,
    summary: finalSummary,
    model_used: finalModelUsed,
    skipped: finalSkipped,
  };
}

function safeParseVerdict(text: string): { pass: boolean; defects: VisualDefect[]; summary: string } | null {
  if (!text) return null;
  let raw = text.trim();
  const fenceMatch = raw.match(/^```(?:json)?\s*([\s\S]*?)```\s*$/i);
  if (fenceMatch) raw = fenceMatch[1].trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      parsed = JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const p = parsed as Record<string, unknown>;
  const defectsRaw = Array.isArray(p.defects) ? p.defects : [];
  const defects: VisualDefect[] = [];
  for (const d of defectsRaw) {
    if (!d || typeof d !== 'object') continue;
    const r = d as Record<string, unknown>;
    const category = coerceCategory(r.category);
    const severity = coerceSeverity(r.severity);
    if (!category || !severity) continue;
    defects.push({
      category,
      severity,
      route: typeof r.route === 'string' ? r.route : 'unknown',
      viewport: typeof r.viewport === 'string' ? r.viewport : 'unknown',
      description: typeof r.description === 'string' ? r.description.slice(0, 400) : '',
      fix_hint: typeof r.fix_hint === 'string' ? r.fix_hint.slice(0, 400) : undefined,
    });
  }
  return {
    pass: !!p.pass,
    defects,
    summary: typeof p.summary === 'string' ? p.summary.slice(0, 400) : '',
  };
}

function coerceCategory(v: unknown): VisualDefect['category'] | null {
  const allowed: VisualDefect['category'][] = [
    'hierarchy',
    'spacing',
    'typography',
    'color_contrast',
    'responsive',
    'copy',
    'state_missing',
    'broken_visual',
  ];
  return typeof v === 'string' && (allowed as string[]).includes(v)
    ? (v as VisualDefect['category'])
    : null;
}

function coerceSeverity(v: unknown): VisualDefect['severity'] | null {
  const allowed: VisualDefect['severity'][] = ['blocker', 'major', 'minor'];
  return typeof v === 'string' && (allowed as string[]).includes(v)
    ? (v as VisualDefect['severity'])
    : null;
}

export function mergeCriticIntoVisualSignal(
  signal: VisualSignal,
  critic: VisualCriticResult,
): VisualSignal {
  return {
    ...signal,
    ok: signal.ok && !verdictBlocksGate(critic),
    pass: !verdictBlocksGate(critic),
    summary: critic.summary,
    defects: critic.defects,
  };
}

/**
 * Pass/fail logic the gate uses: block on blockers or 2+ majors; minors log only.
 */
export function verdictBlocksGate(critic: VisualCriticResult): boolean {
  if (critic.skipped) return false;
  const blockers = critic.defects.filter((d) => d.severity === 'blocker').length;
  const majors = critic.defects.filter((d) => d.severity === 'major').length;
  return blockers > 0 || majors >= 2;
}
