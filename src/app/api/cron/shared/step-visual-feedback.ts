import type { VisualDefect } from './step-iteration-signals';
import type { VisualProbeViewport } from './step-visual-probe';

const MAX_VISUAL_SCREENSHOTS = 2;
const VISUAL_SCREENSHOT_MARKER = 'visual_screenshot_url:';
const IMAGE_WORTHY_CATEGORIES = new Set<VisualDefect['category']>([
  'hierarchy',
  'spacing',
  'typography',
  'color_contrast',
  'responsive',
  'state_missing',
  'broken_visual',
]);

const MOBILE_VIEWPORT: VisualProbeViewport = {
  name: 'mobile',
  width: 390,
  height: 844,
  deviceScaleFactor: 1,
  isMobile: true,
};

const DESKTOP_VIEWPORT: VisualProbeViewport = {
  name: 'desktop',
  width: 1280,
  height: 800,
  deviceScaleFactor: 1,
  isMobile: false,
};

export interface VisualProbePlan {
  enabled: boolean;
  routes: string[];
  viewports: VisualProbeViewport[];
  runScenarios: boolean;
  reason: string;
}

interface BuildVisualProbePlanInput {
  explicit?: boolean;
  gitRepoKind: 'applications' | 'automation';
  changedFiles: string[];
  inferredPageRoutes: string[];
  stepContext?: {
    title?: string;
    instructions?: string;
    expected_output?: string;
  };
}

function isFrontendFile(file: string): boolean {
  return (
    file.startsWith('src/components/') ||
    (file.startsWith('src/app/') && !file.startsWith('src/app/api/')) ||
    file.endsWith('.css') ||
    /(?:^|\/)(?:tailwind|postcss)\.config\.[^/]+$/.test(file)
  );
}

function normalizePageRoute(candidate: string): string | null {
  const route = candidate.trim().replace(/[),.;:]+$/, '');
  if (!route.startsWith('/') || route.startsWith('//')) return null;
  if (
    route.startsWith('/api/') ||
    route.startsWith('/src/') ||
    route.startsWith('/public/') ||
    route.includes('[') ||
    /\.[a-z0-9]{2,8}$/i.test(route)
  ) {
    return null;
  }
  return route.length > 1 ? route.replace(/\/+$/, '') : '/';
}

export function extractPageRoutesFromStepContext(
  context?: BuildVisualProbePlanInput['stepContext'],
): string[] {
  const text = [context?.title, context?.instructions, context?.expected_output]
    .filter(Boolean)
    .join('\n');
  const routes = new Set<string>();
  const routePattern = /\/[a-zA-Z0-9][a-zA-Z0-9._~!$&'()*+,;=:@%/-]*/g;
  let match: RegExpExecArray | null;
  while ((match = routePattern.exec(text))) {
    const preceding = match.index > 0 ? text[match.index - 1] : '';
    if (preceding === ':' || preceding === '/') continue;
    const route = normalizePageRoute(match[0]);
    if (route) routes.add(route);
  }
  return Array.from(routes);
}

export function buildVisualProbePlan(input: BuildVisualProbePlanInput): VisualProbePlan {
  if (input.explicit === false) {
    return {
      enabled: false,
      routes: [],
      viewports: [],
      runScenarios: false,
      reason: 'explicitly_disabled',
    };
  }

  const touchesFrontend =
    input.changedFiles.some(isFrontendFile) ||
    input.inferredPageRoutes.length > 0;
  const forced = input.explicit === true;
  if (!forced && (input.gitRepoKind !== 'applications' || !touchesFrontend)) {
    return {
      enabled: false,
      routes: [],
      viewports: [],
      runScenarios: false,
      reason: input.gitRepoKind !== 'applications' ? 'non_application_repo' : 'no_frontend_changes',
    };
  }

  const contextRoutes = extractPageRoutesFromStepContext(input.stepContext);
  const candidates = [...contextRoutes, ...input.inferredPageRoutes]
    .map(normalizePageRoute)
    .filter((route): route is string => !!route);
  const routes = Array.from(new Set(candidates)).slice(0, MAX_VISUAL_SCREENSHOTS);
  if (routes.length === 0) routes.push('/');

  // Keep the budget at two images: one route gets responsive coverage, while
  // two routes get one representative desktop capture each.
  const viewports = routes.length === 1
    ? [MOBILE_VIEWPORT, DESKTOP_VIEWPORT]
    : [DESKTOP_VIEWPORT];

  return {
    enabled: true,
    routes,
    viewports,
    // Full scenario suites remain an explicit QA operation; automatic visual
    // checks should not multiply the latency of every frontend step.
    runScenarios: forced,
    reason: forced ? 'explicitly_enabled' : 'frontend_changes',
  };
}

interface VisualFeedbackScreenshot {
  route: string;
  viewport: string;
  url: string;
}

interface VisualFeedbackVerdict {
  summary: string;
  defects: VisualDefect[];
}

function severityRank(severity: VisualDefect['severity']): number {
  if (severity === 'blocker') return 0;
  if (severity === 'major') return 1;
  return 2;
}

function screenshotForDefect(
  defect: VisualDefect | undefined,
  screenshots: VisualFeedbackScreenshot[],
): VisualFeedbackScreenshot | undefined {
  if (!defect) return screenshots[0];
  return (
    screenshots.find(
      (shot) => shot.route === defect.route && shot.viewport === defect.viewport,
    ) ?? screenshots.find((shot) => shot.route === defect.route) ?? screenshots[0]
  );
}

export function selectVisualFeedbackScreenshotUrl(
  verdict: VisualFeedbackVerdict,
  screenshots: VisualFeedbackScreenshot[],
): string | undefined {
  const blockingDefects = [...verdict.defects]
    .filter((defect) => defect.severity === 'blocker' || defect.severity === 'major')
    .sort((a, b) => severityRank(a.severity) - severityRank(b.severity));
  const imageDefect =
    blockingDefects.find((defect) => IMAGE_WORTHY_CATEGORIES.has(defect.category)) ??
    blockingDefects[0];
  if (!imageDefect) return undefined;
  return screenshotForDefect(imageDefect, screenshots)?.url;
}

export function formatVisualGateFeedback(
  verdict: VisualFeedbackVerdict,
  screenshots: VisualFeedbackScreenshot[],
): string {
  const defects = [...verdict.defects]
    .sort((a, b) => severityRank(a.severity) - severityRank(b.severity))
    .slice(0, 3);
  const screenshotUrl = selectVisualFeedbackScreenshotUrl(verdict, screenshots);
  const lines = ['Visual critic blocked the gate.'];

  if (screenshotUrl) {
    lines.push(`${VISUAL_SCREENSHOT_MARKER} ${screenshotUrl}`);
  }
  lines.push(`Summary: ${verdict.summary.slice(0, 400)}`);
  if (defects.length) {
    lines.push('Defects to fix:');
    for (const defect of defects) {
      lines.push(
        `- [${defect.severity}/${defect.category}] ${defect.route} (${defect.viewport}): ${defect.description.slice(0, 300)}${defect.fix_hint ? ` | Fix: ${defect.fix_hint.slice(0, 300)}` : ''}`,
      );
    }
  }
  lines.push('Re-run the same route and viewport after the fix; do not redesign unrelated screens.');
  return lines.join('\n').slice(0, 3_000);
}

export function extractVisualFeedbackScreenshotUrl(text: string | null | undefined): string | null {
  if (!text) return null;
  const match = text.match(/^visual_screenshot_url:\s*(https?:\/\/\S+)/im);
  return match?.[1] ?? null;
}
