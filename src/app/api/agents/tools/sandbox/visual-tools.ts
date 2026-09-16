/**
 * Visual feedback-loop tools exposed to sandbox agents:
 *
 *   - sandbox_capture_screenshots: boots `next start`, navigates each
 *     route × viewport with puppeteer (on the host), uploads full-page
 *     screenshots to Supabase Storage, and returns their URLs together
 *     with browser console entries, page errors, and failed requests.
 *
 *   - sandbox_visual_critique: runs the vision-model design reviewer
 *     against captured screenshots and returns a strict verdict
 *     (pass + structured defects).
 *
 * These wrap the same primitives the per-step gate uses in Phase 3
 * (`runVisualProbe` + `runVisualCritic`), so the agent can iterate on
 * design issues during its own turn instead of waiting for the gate.
 */

import type { Sandbox } from '@vercel/sandbox';
import { SandboxService } from '@/lib/services/sandbox-service';
import { liveSandbox, type SandboxToolsContext, deductSandboxToolCredits } from '@/app/api/agents/tools/sandbox/assistantProtocol';
import { runRuntimeProbe, stopProbeServer } from '@/app/api/cron/shared/step-runtime-probe';
import {
  runVisualProbe,
  type VisualProbeViewport,
} from '@/app/api/cron/shared/step-visual-probe';
import { runVisualCritic } from '@/app/api/cron/shared/step-visual-critic';

const PROBE_PORT = SandboxService.VISUAL_PROBE_PORT;

export function sandboxCaptureScreenshotsTool(sandbox: Sandbox, requirementId?: string, toolsCtx?: SandboxToolsContext) {
  return {
    name: 'sandbox_capture_screenshots',
    description:
      'Boot `next start` inside the sandbox and use puppeteer against the public tunnel URL to capture viewport screenshots per route × viewport. Also records browser console entries, page errors, and failed network requests per page. Screenshots are stored privately and opaque locators are returned. Use this to SEE what the page actually renders before ending a step, or to feed sandbox_visual_critique.',
    parameters: {
      type: 'object',
      properties: {
        routes: {
          type: 'array',
          maxItems: 6,
          items: { type: 'string', maxLength: 300 },
          description: 'Absolute page paths to capture (e.g. ["/", "/pricing"]). Defaults to ["/"]. Route × viewport count must not exceed 6.',
        },
        protected_routes: {
          type: 'array',
          maxItems: 6,
          items: { type: 'string', maxLength: 300 },
          description:
            'Subset of routes explicitly expected to redirect to a local login page when unauthenticated.',
        },
        viewports: {
          type: 'array',
          maxItems: 6,
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', maxLength: 40, description: 'Label used in output and storage path (e.g. "mobile", "desktop").' },
              width: { type: 'number', minimum: 320, maximum: 1920 },
              height: { type: 'number', minimum: 320, maximum: 1200 },
              device_scale_factor: { type: 'number', minimum: 1, maximum: 2 },
              is_mobile: { type: 'boolean' },
            },
            required: ['name', 'width', 'height'],
          },
          description: 'Optional viewport matrix. Defaults to [mobile 390×844 @2x, desktop 1440×900].',
        },
        step_order: {
          type: 'number',
          description: 'Optional step index used for the storage folder. Defaults to 0.',
        },
        boot_timeout_ms: {
          type: 'number',
          minimum: 5_000,
          maximum: 60_000,
          description: 'Max time (ms) to wait for `next start` to boot before capturing. Defaults to 25000.',
        },
        page_timeout_ms: {
          type: 'number',
          minimum: 1_000,
          maximum: 30_000,
          description: 'Per-page navigation timeout (ms). Defaults to 15000.',
        },
      },
    },
    execute: async (args: {
      routes?: string[];
      protected_routes?: string[];
      viewports?: Array<{
        name: string;
        width: number;
        height: number;
        device_scale_factor?: number;
        is_mobile?: boolean;
      }>;
      step_order?: number;
      boot_timeout_ms?: number;
      page_timeout_ms?: number;
    }) => {
      if (!requirementId) {
        return {
          ok: false,
          error: 'A requirement context is required for scoped screenshot storage.',
        };
      }
      const creditCheck = await deductSandboxToolCredits(toolsCtx, 'sandbox_capture_screenshots', args);
      if (!creditCheck.success) {
        return { ok: false, error: creditCheck.error };
      }

      const s0 = liveSandbox(sandbox, toolsCtx);
      const routes = (args.routes && args.routes.length ? args.routes : ['/'])
        .map((r) => (typeof r === 'string' ? r.trim() : ''))
        .filter(Boolean);
      if (!routes.length) {
        return { ok: false, error: 'No valid routes provided.' };
      }
      const viewports: VisualProbeViewport[] | undefined = args.viewports?.length
        ? args.viewports
            .filter((v) => v && v.name && v.width > 0 && v.height > 0)
            .map((v) => ({
              name: v.name,
              width: v.width,
              height: v.height,
              deviceScaleFactor: v.device_scale_factor,
              isMobile: v.is_mobile,
            }))
        : undefined;
      const screenshotCount = routes.length * (viewports?.length || 2);
      if (screenshotCount > 6) {
        return {
          ok: false,
          error: `Requested ${screenshotCount} screenshots; the per-call limit is 6.`,
        };
      }

      const rt = await runRuntimeProbe({
        sandbox: s0,
        pageRoutes: [routes[0]],
        apiRoutes: [],
        durationMs: Math.max(
          5_000,
          Math.min(60_000, args.boot_timeout_ms ?? 25_000),
        ),
        port: PROBE_PORT,
        keepServerAlive: true,
      });
      if (!rt.ok || rt.startup_error) {
        await stopProbeServer(s0, rt.port);
        return {
          ok: false,
          server_booted: false,
          error:
            rt.startup_error ||
            'next start failed to boot cleanly — fix runtime errors before capturing screenshots.',
          server_log_tail: rt.server_log_tail.slice(-4000),
          server_errors: rt.server_errors.slice(0, 20),
        };
      }

      try {
        const visual = await runVisualProbe({
          sandbox: s0,
          port: rt.port,
          pageRoutes: routes,
          viewports,
          requirementId,
          stepOrder: args.step_order ?? 0,
          pageTimeoutMs: args.page_timeout_ms,
          fullPage: false,
          imageType: 'jpeg',
          imageQuality: 60,
          hydrationWaitMs: 500,
          protectedRoutes: args.protected_routes,
        });
        const errorEntries = visual.console.entries.filter((e) => e.level === 'error');
        const warnEntries = visual.console.entries.filter((e) => e.level === 'warn');
        return {
          ok: visual.ok,
          server_booted: true,
          base_url: visual.base_url,
          duration_ms: visual.duration_ms,
          error: visual.error,
          screenshots: visual.screenshots,
          auth_redirects: visual.auth_redirects,
          console_ok: visual.console.ok,
          console_errors: errorEntries.slice(0, 40),
          console_errors_truncated: errorEntries.length > 40,
          console_warnings: warnEntries.slice(0, 20),
          page_errors: visual.console.page_errors.slice(0, 20),
          failed_requests: visual.console.failed_requests.slice(0, 30),
          telemetry_dropped: visual.console.telemetry_dropped,
        };
      } finally {
        await stopProbeServer(s0, rt.port);
      }
    },
  };
}

export function sandboxVisualCritiqueTool(
  requirementId?: string,
  toolsCtx?: SandboxToolsContext,
) {
  return {
    name: 'sandbox_visual_critique',
    description:
      'Run the vision-model design reviewer against previously captured screenshots (URLs typically returned by sandbox_capture_screenshots). Returns a strict verdict: pass boolean, 1–2 sentence summary, and a defects list with category, severity, route, viewport, description, and fix_hint. Use this to get an objective check on hierarchy, spacing, typography, contrast, responsive, copy, and broken visuals before closing a step. Up to 6 screenshots are evaluated per call.',
    parameters: {
      type: 'object',
      properties: {
        screenshots: {
          type: 'array',
          maxItems: 6,
          items: {
            type: 'object',
            properties: {
              route: { type: 'string', maxLength: 300 },
              viewport: { type: 'string', maxLength: 80 },
              url: {
                type: 'string',
                maxLength: 2_000,
                description: 'Screenshot storage locator returned by sandbox_capture_screenshots.',
              },
            },
            required: ['route', 'viewport', 'url'],
          },
          description: 'Screenshots to evaluate. Max 6 are sent to the vision model.',
        },
        step: {
          type: 'object',
          properties: {
            order: { type: 'number', description: 'Step index/order for context.' },
            title: { type: 'string', maxLength: 200 },
            instructions: {
              type: 'string',
              maxLength: 2_000,
              description: 'Short paraphrase of step instructions (first ~600 chars used).',
            },
            expected_output: { type: 'string', maxLength: 2_000 },
          },
          required: ['order'],
          description: 'Step context so the critic can evaluate against the actual intent.',
        },
        rubric: {
          type: 'string',
          maxLength: 4_000,
          description: 'Optional override of the default design-quality rubric.',
        },
        brand_context: {
          type: 'string',
          maxLength: 2_000,
          description: 'Optional brand guidelines, tone, or palette hints.',
        },
      },
      required: ['screenshots', 'step'],
    },
    execute: async (args: {
      screenshots: Array<{ route: string; viewport: string; url: string }>;
      step: { order: number; title?: string; instructions?: string; expected_output?: string };
      rubric?: string;
      brand_context?: string;
    }) => {
      if (!requirementId) {
        return {
          ok: false,
          error: 'A requirement context is required for scoped visual evidence.',
        };
      }
      const creditCheck = await deductSandboxToolCredits(toolsCtx, 'sandbox_visual_critique', { step: args.step });
      if (!creditCheck.success) {
        return { ok: false, error: creditCheck.error };
      }

      const shots = (args.screenshots || []).filter(
        (s) =>
          s &&
          typeof s.url === 'string' &&
          typeof s.route === 'string' &&
          typeof s.viewport === 'string' &&
          s.url.trim(),
      );
      if (!shots.length) {
        return { ok: false, error: 'No valid screenshots provided.' };
      }
      if (!args.step || typeof args.step.order !== 'number') {
        return { ok: false, error: 'step.order is required.' };
      }
      const critic = await runVisualCritic({
        screenshots: shots,
        step: args.step,
        rubric: args.rubric,
        brand_context: args.brand_context,
        requirementId,
        maxScreenshots: 6,
      });
      return {
        ok: !critic.skipped,
        pass: critic.pass,
        summary: critic.summary,
        defects: critic.defects,
        model_used: critic.model_used,
        skipped: critic.skipped,
      };
    },
  };
}
