/**
 * QA-oriented sandbox tools: give the agent direct, deterministic access to
 * runtime / scenario / log probes that the automated gate runs, so a QA step
 * can iterate without shelling out raw curl commands.
 *
 * Each tool is self-contained: spins up `next start` when needed, runs its
 * probe, tears everything down. No hidden server state is leaked across
 * calls except /tmp log files the tools may tail.
 */

import type { Sandbox } from '@vercel/sandbox';
import { SandboxService } from '@/lib/services/sandbox-service';
import { liveSandbox, type SandboxToolsContext, deductSandboxToolCredits } from '@/app/api/agents/tools/sandbox/assistantProtocol';
import {
  runRuntimeProbe,
  stopProbeServer,
  summarizeRuntimeProbe,
  type RuntimeProbeApiTarget,
} from '@/app/api/cron/shared/step-runtime-probe';
import { runE2eScenarios } from '@/app/api/cron/shared/step-e2e-runner';
import {
  sandboxCaptureScreenshotsTool,
  sandboxVisualCritiqueTool,
} from '@/app/api/agents/tools/sandbox/visual-tools';

const WD = SandboxService.WORK_DIR;
const PROBE_PORT = SandboxService.VISUAL_PROBE_PORT;

async function readTail(sandbox: Sandbox, path: string, maxBytes: number): Promise<string> {
  try {
    const res = await sandbox.runCommand('sh', [
      '-c',
      `tail -c ${maxBytes} ${path} 2>/dev/null || true`,
    ]);
    return (await res.stdout()) || '';
  } catch {
    return '';
  }
}

export function sandboxProbeRoutesTool(sandbox: Sandbox, toolsCtx?: SandboxToolsContext) {
  return {
    name: 'sandbox_probe_routes',
    description:
      'Boot `next start` inside the sandbox and probe one or more HTTP page routes with curl. Returns per-route status, content-type, body snippet, server error summary, and server log tail. Use this to verify a page renders at runtime before marking a step as done.',
    parameters: {
      type: 'object',
      properties: {
        routes: {
          type: 'array',
          items: { type: 'string' },
          description: 'Absolute paths to probe (e.g. ["/", "/pricing"]). Defaults to ["/"].',
        },
        duration_ms: {
          type: 'number',
          description: 'Max time to wait for the server to boot and probe to complete. Defaults to 20000.',
        },
      },
    },
    execute: async (args: { routes?: string[]; duration_ms?: number }) => {
      const creditCheck = await deductSandboxToolCredits(toolsCtx, 'sandbox_probe_routes', args);
      if (!creditCheck.success) {
        return { ok: false, error: creditCheck.error };
      }

      const s0 = liveSandbox(sandbox, toolsCtx);
      const routes = (args.routes && args.routes.length ? args.routes : ['/']).map((r) => r.trim()).filter(Boolean);
      const result = await runRuntimeProbe({
        sandbox: s0,
        pageRoutes: routes,
        durationMs: args.duration_ms,
        port: PROBE_PORT,
        keepServerAlive: false,
      });
      return {
        ok: result.ok,
        port: result.port,
        duration_ms: result.duration_ms,
        startup_error: result.startup_error ?? null,
        pages: result.pages,
        server_errors: result.server_errors.slice(0, 20),
        server_log_tail: result.server_log_tail.slice(-4000),
        summary: summarizeRuntimeProbe(result),
      };
    },
  };
}

export function sandboxProbeApiTool(sandbox: Sandbox, toolsCtx?: SandboxToolsContext) {
  return {
    name: 'sandbox_probe_api',
    description:
      'Boot `next start` inside the sandbox and probe API routes (src/app/api/**) with curl. Each target can include method + JSON payload. Use this to verify a server action or API route works at runtime.',
    parameters: {
      type: 'object',
      properties: {
        endpoints: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'Absolute route path, e.g. "/api/contact"' },
              method: {
                type: 'string',
                enum: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
                description: 'HTTP method. Defaults to GET.',
              },
              payload: {
                description: 'Optional JSON-serializable request body (objects, arrays, primitives).',
              },
            },
            required: ['path'],
          },
          description: 'List of API endpoints to probe.',
        },
        duration_ms: {
          type: 'number',
          description: 'Max time to wait for the server to boot and probe to complete. Defaults to 20000.',
        },
      },
      required: ['endpoints'],
    },
    execute: async (args: {
      endpoints: Array<{ path: string; method?: RuntimeProbeApiTarget['method']; payload?: unknown }>;
      duration_ms?: number;
    }) => {
      const creditCheck = await deductSandboxToolCredits(toolsCtx, 'sandbox_probe_api', args);
      if (!creditCheck.success) {
        return { ok: false, error: creditCheck.error };
      }

      const s0 = liveSandbox(sandbox, toolsCtx);
      const apis: RuntimeProbeApiTarget[] = (args.endpoints || [])
        .filter((e) => e && typeof e.path === 'string' && e.path.trim())
        .map((e) => ({
          path: e.path.trim(),
          method: e.method || 'GET',
          payload: e.payload,
          payload_source: e.payload != null ? 'scenario' : 'none',
        }));
      if (!apis.length) {
        return { ok: false, error: 'No valid endpoints provided.' };
      }
      const result = await runRuntimeProbe({
        sandbox: s0,
        pageRoutes: [],
        apiRoutes: apis,
        durationMs: args.duration_ms,
        port: PROBE_PORT,
        keepServerAlive: false,
      });
      return {
        ok: result.ok,
        port: result.port,
        duration_ms: result.duration_ms,
        startup_error: result.startup_error ?? null,
        apis: result.apis,
        server_errors: result.server_errors.slice(0, 20),
        server_log_tail: result.server_log_tail.slice(-4000),
      };
    },
  };
}

export function sandboxRunScenarioTool(sandbox: Sandbox, toolsCtx?: SandboxToolsContext) {
  return {
    name: 'sandbox_run_scenario',
    description:
      'Run declarative E2E scenarios from `.qa/scenarios/*.json` against a freshly booted `next start` server. Returns per-scenario outcomes (pass/fail, step index of first failure, console errors, network failures). Use this after authoring or editing scenarios to verify coverage before marking the QA step done.',
    parameters: {
      type: 'object',
      properties: {
        scenarios_dir: {
          type: 'string',
          description: `Directory relative to ${WD} where scenario JSONs live. Defaults to ".qa/scenarios".`,
        },
        only: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Optional list of scenario file basenames (without extension) to run. If omitted, runs all scenarios in the directory.',
        },
        duration_ms: {
          type: 'number',
          description: 'Max time to wait for the server to boot before running scenarios. Defaults to 25000.',
        },
      },
    },
    execute: async (args: { scenarios_dir?: string; only?: string[]; duration_ms?: number }) => {
      const creditCheck = await deductSandboxToolCredits(toolsCtx, 'sandbox_run_scenario', args);
      if (!creditCheck.success) {
        return { ok: false, error: creditCheck.error };
      }

      const s0 = liveSandbox(sandbox, toolsCtx);
      const rt = await runRuntimeProbe({
        sandbox: s0,
        pageRoutes: ['/'],
        apiRoutes: [],
        durationMs: args.duration_ms ?? 25_000,
        port: PROBE_PORT,
        keepServerAlive: true,
      });
      if (!rt.ok || rt.startup_error) {
        await stopProbeServer(s0, rt.port);
        return {
          ok: false,
          server_booted: false,
          error: rt.startup_error || 'next start failed to boot cleanly — fix runtime errors before running scenarios.',
          server_log_tail: rt.server_log_tail.slice(-4000),
          server_errors: rt.server_errors.slice(0, 20),
        };
      }

      try {
        const result = await runE2eScenarios({
          sandbox: s0,
          scenariosDir: args.scenarios_dir,
          port: PROBE_PORT,
          stepOrder: 0,
        });
        const filtered = args.only?.length
          ? result.scenarios.filter((s) => args.only!.some((n) => s.scenario.startsWith(n) || s.scenario === n))
          : result.scenarios;
        const allPassed = filtered.every((s) => s.pass);
        return {
          ok: allPassed,
          server_booted: true,
          base_url: result.base_url,
          scenarios_read: result.scenarios_read,
          scenarios: filtered.map((s) => {
            const firstFail = s.steps.find((st) => !st.ok);
            return {
              name: s.scenario,
              ok: s.pass,
              duration_ms: s.duration_ms,
              failed_step_index: firstFail?.index,
              failed_action: firstFail?.action,
              failed_message: firstFail?.error,
              steps: s.steps,
            };
          }),
          error: result.error,
        };
      } finally {
        await stopProbeServer(s0, rt.port);
      }
    },
  };
}

export function sandboxTailServerLogTool(sandbox: Sandbox, toolsCtx?: SandboxToolsContext) {
  return {
    name: 'sandbox_tail_server_log',
    description:
      'Read the tail of the most recent `next start` log written by a runtime probe (includes server-side errors, unhandled rejections, hydration warnings). Useful when a page responded 500 and you want the stack trace.',
    parameters: {
      type: 'object',
      properties: {
        port: {
          type: 'number',
          description: `Probe port. Defaults to ${PROBE_PORT}.`,
        },
        max_bytes: {
          type: 'number',
          description: 'Max bytes to return from the end of the log. Defaults to 8000.',
        },
      },
    },
    execute: async (args: { port?: number; max_bytes?: number }) => {
      const creditCheck = await deductSandboxToolCredits(toolsCtx, 'sandbox_tail_server_log', args);
      if (!creditCheck.success) {
        return { path: '', bytes_returned: 0, tail: '', error: creditCheck.error };
      }

      const s0 = liveSandbox(sandbox, toolsCtx);
      const port = args.port ?? PROBE_PORT;
      const maxBytes = Math.max(512, Math.min(32_000, args.max_bytes ?? 8_000));
      const path = `/tmp/makinari-server-${port}.log`;
      const tail = await readTail(s0, path, maxBytes);
      return {
        path,
        bytes_returned: tail.length,
        tail,
      };
    },
  };
}

export function sandboxTailApiLogTool(sandbox: Sandbox, toolsCtx?: SandboxToolsContext) {
  return {
    name: 'sandbox_tail_api_log',
    description:
      'Inspect the server log produced by the last runtime probe filtered to lines mentioning an API route (e.g. "/api/contact"). Useful when an API call returned non-2xx and you need the server-side error detail.',
    parameters: {
      type: 'object',
      properties: {
        route: {
          type: 'string',
          description: 'Substring to filter log lines by (usually the API route path, e.g. "/api/contact").',
        },
        port: {
          type: 'number',
          description: `Probe port. Defaults to ${PROBE_PORT}.`,
        },
        max_lines: {
          type: 'number',
          description: 'Max lines to return. Defaults to 80.',
        },
      },
      required: ['route'],
    },
    execute: async (args: { route: string; port?: number; max_lines?: number }) => {
      const creditCheck = await deductSandboxToolCredits(toolsCtx, 'sandbox_tail_api_log', args);
      if (!creditCheck.success) {
        return { path: '', needle: '', lines: [], error: creditCheck.error };
      }

      const s0 = liveSandbox(sandbox, toolsCtx);
      const port = args.port ?? PROBE_PORT;
      const maxLines = Math.max(10, Math.min(500, args.max_lines ?? 80));
      const path = `/tmp/makinari-server-${port}.log`;
      const needle = String(args.route || '').replace(/'/g, "'\\''");
      if (!needle.trim()) {
        return { path, lines: [], error: 'route must be a non-empty substring' };
      }
      try {
        const res = await s0.runCommand('sh', [
          '-c',
          `grep -F -- '${needle}' ${path} 2>/dev/null | tail -n ${maxLines} || true`,
        ]);
        const out = (await res.stdout()) || '';
        const lines = out.split('\n').filter(Boolean);
        return { path, needle, lines };
      } catch (e: unknown) {
        return { path, needle, lines: [], error: e instanceof Error ? e.message : String(e) };
      }
    },
  };
}

export { sandboxCaptureScreenshotsTool, sandboxVisualCritiqueTool };

export function getQaSandboxTools(sandbox: Sandbox, requirementId?: string, toolsCtx?: SandboxToolsContext) {
  return [
    sandboxProbeRoutesTool(sandbox, toolsCtx),
    sandboxProbeApiTool(sandbox, toolsCtx),
    sandboxRunScenarioTool(sandbox, toolsCtx),
    sandboxTailServerLogTool(sandbox, toolsCtx),
    sandboxTailApiLogTool(sandbox, toolsCtx),
    sandboxCaptureScreenshotsTool(sandbox, requirementId, toolsCtx),
    sandboxVisualCritiqueTool(toolsCtx),
  ];
}
