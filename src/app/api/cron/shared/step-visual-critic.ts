/**
 * Vision-model "design reviewer" — takes step screenshots produced by
 * runVisualProbe, sends them to a vision-capable model with a strict JSON
 * schema, and returns a VisualSignal enriched with pass/defects.
 *
 * Provider: Vercel AI Gateway (OpenAI-compatible). Falls back gracefully —
 * when env is missing the function returns pass=true and summary explaining
 * the skip so the gate keeps moving.
 */

import type { VisualSignal, VisualDefect } from './step-iteration-signals';

const DEFAULT_VISION_MODEL = process.env.MAKINARI_VISUAL_CRITIC_MODEL || 'gpt-4o-mini';
const DEFAULT_TIMEOUT_MS = 45_000;
const MAX_SCREENSHOTS_PER_CALL = 6;

export type VisualCriticInput = {
  screenshots: Array<{ route: string; viewport: string; url: string }>;
  step: { order: number; title?: string; instructions?: string; expected_output?: string };
  rubric?: string;
  brand_context?: string;
  model?: string;
  timeoutMs?: number;
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

export async function runVisualCritic(input: VisualCriticInput): Promise<VisualCriticResult> {
  const baseURL = process.env.VERCEL_AI_GATEWAY_OPENAI || process.env.MICROSOFT_AZURE_OPENAI_ENDPOINT;
  const apiKey = process.env.VERCEL_AI_GATEWAY_API_KEY || process.env.MICROSOFT_AZURE_OPENAI_API_KEY;
  if (!baseURL || !apiKey) {
    return {
      pass: true,
      defects: [],
      summary: 'visual critic skipped — API keys not configured',
      skipped: 'missing_env',
    };
  }
  if (!input.screenshots.length) {
    return { pass: true, defects: [], summary: 'no screenshots to evaluate', skipped: 'no_screenshots' };
  }

  const screenshots = input.screenshots.slice(0, MAX_SCREENSHOTS_PER_CALL);
  const model = input.model || DEFAULT_VISION_MODEL;
  const rubric = input.rubric || DEFAULT_RUBRIC;
  const timeout = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;

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
    'Rubric:',
    rubric,
  ].join('\n');

  const userBlocks: Array<
    | { type: 'text'; text: string }
    | { type: 'image_url'; image_url: { url: string } }
  > = [];
  userBlocks.push({
    type: 'text',
    text: [
      `Step ${input.step.order}${input.step.title ? `: ${input.step.title}` : ''}`,
      input.step.instructions ? `Instructions: ${input.step.instructions.slice(0, 600)}` : '',
      input.step.expected_output ? `Expected output: ${input.step.expected_output.slice(0, 400)}` : '',
      input.brand_context ? `Brand context: ${input.brand_context.slice(0, 400)}` : '',
      '',
      'Screenshots follow (each preceded by its route + viewport metadata).',
    ]
      .filter(Boolean)
      .join('\n'),
  });
  for (const s of screenshots) {
    userBlocks.push({ type: 'text', text: `route="${s.route}" viewport="${s.viewport}"` });
    userBlocks.push({ type: 'image_url', image_url: { url: s.url } });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  let rawText = '';
  try {
    const isAzure = baseURL === process.env.MICROSOFT_AZURE_OPENAI_ENDPOINT;
    const deployment = process.env.MICROSOFT_AZURE_OPENAI_DEPLOYMENT || 'gpt-4o';
    const apiVersion = process.env.MICROSOFT_AZURE_OPENAI_API_VERSION || '2024-08-01-preview';
    
    const url = isAzure 
      ? `${baseURL.replace(/\/$/, '')}/openai/deployments/${encodeURIComponent(deployment)}/chat/completions?api-version=${encodeURIComponent(apiVersion)}`
      : `${baseURL.replace(/\/$/, '')}/v1/chat/completions`;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (isAzure) {
      headers['api-key'] = apiKey;
    } else {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }

    const resp = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: isAzure ? undefined : model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userBlocks },
        ],
        temperature: 0.1,
        response_format: { type: 'json_object' },
        stream: false,
      }),
      signal: controller.signal,
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      return {
        pass: true,
        defects: [],
        summary: `visual critic skipped — upstream ${resp.status}: ${text.slice(0, 200)}`,
        skipped: 'upstream_error',
        model_used: model,
      };
    }
    const data = await resp.json();
    rawText = data?.choices?.[0]?.message?.content ?? '';
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      pass: true,
      defects: [],
      summary: `visual critic skipped — request failed: ${msg.slice(0, 200)}`,
      skipped: 'request_failed',
      model_used: model,
    };
  } finally {
    clearTimeout(timer);
  }

  const parsed = safeParseVerdict(rawText);
  if (!parsed) {
    return {
      pass: true,
      defects: [],
      summary: `visual critic skipped — could not parse JSON: ${rawText.slice(0, 200)}`,
      skipped: 'parse_error',
      model_used: model,
    };
  }

  return {
    pass: !!parsed.pass,
    defects: parsed.defects,
    summary: parsed.summary,
    model_used: model,
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
    ok: signal.ok,
    pass: critic.pass,
    summary: critic.summary,
    defects: critic.defects,
    screenshots: signal.screenshots,
  };
}

/**
 * Pass/fail logic the gate uses: block on blockers or 2+ majors; minors log only.
 */
export function verdictBlocksGate(critic: VisualCriticResult): boolean {
  if (critic.skipped) return false;
  if (!critic.pass) return true;
  const blockers = critic.defects.filter((d) => d.severity === 'blocker').length;
  const majors = critic.defects.filter((d) => d.severity === 'major').length;
  return blockers > 0 || majors >= 2;
}
