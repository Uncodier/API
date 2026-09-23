import type { Sandbox } from '@vercel/sandbox';
import { runWorkflowAgentBrowserCommand } from '@/lib/services/workflow-robot/agent-browser-runtime';
import {
  isBrowserHostnameAllowed,
  normalizeBrowserAllowedDomains,
} from '@/lib/services/workflow-robot/browser-domains';

const MAX_OUTPUT_LENGTH = 60_000;
const SAFE_ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

type BrowserAction =
  | 'open'
  | 'snapshot'
  | 'click'
  | 'fill'
  | 'type'
  | 'get_text'
  | 'wait'
  | 'press'
  | 'close';

export interface SandboxBrowserToolContext {
  secretEnvironment?: Record<string, string>;
  session?: string;
  allowedDomains?: string[];
}

function requireText(value: unknown, field: string): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) throw new Error(`${field} is required.`);
  return text;
}

function browserArgs(
  args: Record<string, unknown>,
  secretEnvironment: Record<string, string>,
  allowedDomains: string[],
): { action: BrowserAction; argv: string[]; secret?: string } {
  const action = args.action as BrowserAction;
  switch (action) {
    case 'open': {
      const url = requireText(args.url, 'url');
      const parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        throw new Error('url must use http or https.');
      }
      if (
        allowedDomains.length > 0 &&
        !isBrowserHostnameAllowed(parsed.hostname, allowedDomains)
      ) {
        throw new Error(`Navigation to "${parsed.hostname}" is outside browser_allowed_domains.`);
      }
      return { action, argv: ['open', url] };
    }
    case 'snapshot':
      return {
        action,
        argv: ['snapshot', ...(args.interactive === false ? [] : ['-i'])],
      };
    case 'click':
      return { action, argv: ['click', requireText(args.ref, 'ref')] };
    case 'fill':
    case 'type': {
      const ref = requireText(args.ref, 'ref');
      const valueEnv = typeof args.value_env === 'string' ? args.value_env.trim() : '';
      if (valueEnv && !SAFE_ENV_NAME.test(valueEnv)) {
        throw new Error('value_env must be a valid environment variable name.');
      }
      const secret = valueEnv ? secretEnvironment[valueEnv] : undefined;
      if (valueEnv && secret === undefined) {
        throw new Error(`Sandbox environment variable "${valueEnv}" is not configured.`);
      }
      const value = valueEnv ? secret! : requireText(args.value, 'value');
      return { action, argv: [action, ref, value], ...(valueEnv ? { secret: value } : {}) };
    }
    case 'get_text':
      return { action, argv: ['get', 'text', requireText(args.ref, 'ref')] };
    case 'wait': {
      const ref = typeof args.ref === 'string' ? args.ref.trim() : '';
      const load = typeof args.load === 'string' ? args.load.trim() : '';
      const milliseconds = Number(args.milliseconds);
      if (ref) return { action, argv: ['wait', ref] };
      if (load) return { action, argv: ['wait', '--load', load] };
      if (Number.isFinite(milliseconds) && milliseconds > 0) {
        return { action, argv: ['wait', String(Math.min(30_000, Math.floor(milliseconds)))] };
      }
      throw new Error('wait requires ref, load, or milliseconds.');
    }
    case 'press':
      return { action, argv: ['press', requireText(args.key, 'key')] };
    case 'close':
      return { action, argv: ['close'] };
    default:
      throw new Error('Unsupported browser action.');
  }
}

function redactText(value: string, secrets: Record<string, string>): string {
  let redacted = value;
  const entries = Object.entries(secrets)
    .filter(([, secret]) => secret.length > 0)
    .sort((a, b) => b[1].length - a[1].length);
  for (const [name, secret] of entries) {
    const replacement = `[REDACTED:${name}]`;
    redacted = redacted.replaceAll(secret, replacement);
    const encoded = encodeURIComponent(secret);
    if (encoded !== secret) redacted = redacted.replaceAll(encoded, replacement);
  }
  return redacted;
}

function boundedBrowserOutput(
  value: unknown,
  secrets: Record<string, string>,
): unknown {
  const serialized =
    typeof value === 'string' ? value : JSON.stringify(value ?? null);
  const redacted = redactText(serialized, secrets);
  const byteLength = Buffer.byteLength(redacted, 'utf8');
  if (byteLength > MAX_OUTPUT_LENGTH) {
    let preview = Buffer.from(redacted, 'utf8')
      .subarray(0, MAX_OUTPUT_LENGTH)
      .toString('utf8');
    while (Buffer.byteLength(preview, 'utf8') > MAX_OUTPUT_LENGTH) {
      preview = preview.slice(0, -1);
    }
    return {
      truncated: true,
      original_bytes: byteLength,
      preview,
    };
  }
  if (typeof value === 'string') return redacted;
  try {
    return JSON.parse(redacted);
  } catch {
    return redacted;
  }
}

function extractCurrentUrl(result: { json: unknown; stdout: string }): string {
  const json = result.json;
  if (typeof json === 'string') return json;
  if (json && typeof json === 'object') {
    const source = json as Record<string, any>;
    const url = source.url ?? source.data?.url ?? source.data;
    if (typeof url === 'string') return url;
  }
  const stdout = result.stdout.trim();
  try {
    const parsed = JSON.parse(stdout);
    if (typeof parsed === 'string') return parsed;
    const url = parsed?.url ?? parsed?.data?.url ?? parsed?.data;
    if (typeof url === 'string') return url;
  } catch {
    // Plain-text output is accepted below.
  }
  return stdout;
}

async function assertCredentialOrigin(
  sandbox: Sandbox,
  session: string | undefined,
  allowedDomains: string[],
): Promise<void> {
  if (allowedDomains.length === 0) {
    throw new Error('value_env requires at least one browser_allowed_domains entry.');
  }
  const current = await runWorkflowAgentBrowserCommand(
    sandbox,
    ['get', 'url'],
    { session, json: true },
  );
  const currentUrl = extractCurrentUrl(current);
  const hostname = new URL(currentUrl).hostname;
  if (!isBrowserHostnameAllowed(hostname, allowedDomains)) {
    throw new Error(`Credentials cannot be filled on untrusted domain "${hostname}".`);
  }
}

export function sandboxBrowserTool(
  sandbox: Sandbox,
  context: SandboxBrowserToolContext = {},
) {
  const secretEnvironment = context.secretEnvironment || {};
  const allowedDomains = normalizeBrowserAllowedDomains(context.allowedDomains);
  return {
    name: 'sandbox_browser',
    description:
      'Control the pre-provisioned agent-browser session in the Vercel Sandbox. ' +
      'Use open, then snapshot to discover refs, then click/fill/type/get_text. ' +
      'For credentials, pass value_env with a configured environment-variable name; it is accepted only on browser_allowed_domains. ' +
      'Do not install browser packages through sandbox_run_command.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['open', 'snapshot', 'click', 'fill', 'type', 'get_text', 'wait', 'press', 'close'],
        },
        url: { type: 'string', description: 'HTTP(S) URL for action=open.' },
        ref: { type: 'string', description: 'Element ref returned by snapshot.' },
        value: {
          type: 'string',
          description: 'Non-secret value for fill/type. Use value_env for credentials.',
        },
        value_env: {
          type: 'string',
          description: 'Environment-variable name whose value is resolved server-side for fill/type.',
        },
        interactive: {
          type: 'boolean',
          description: 'For snapshot, return only interactive elements. Defaults to true.',
        },
        load: {
          type: 'string',
          enum: ['load', 'domcontentloaded', 'networkidle'],
          description: 'Page lifecycle state for action=wait.',
        },
        milliseconds: {
          type: 'number',
          description: 'Bounded delay for action=wait.',
        },
        key: { type: 'string', description: 'Keyboard key for action=press.' },
      },
      required: ['action'],
    },
    execute: async (rawArgs: unknown) => {
      let secret: string | undefined;
      try {
        if (!rawArgs || typeof rawArgs !== 'object') {
          throw new Error('Browser arguments are required.');
        }
        const command = browserArgs(
          rawArgs as Record<string, unknown>,
          secretEnvironment,
          allowedDomains,
        );
        secret = command.secret;
        if (secret !== undefined) {
          await assertCredentialOrigin(
            sandbox,
            context.session,
            allowedDomains,
          );
        }
        const result = await runWorkflowAgentBrowserCommand(
          sandbox,
          command.argv,
          {
            session: context.session,
            json: true,
          },
        );
        const output = secret !== undefined
          ? { redacted: true, message: 'Credential value filled.' }
          : boundedBrowserOutput(
            result.json ?? result.stdout,
            secretEnvironment,
          );
        return {
          ok: true,
          action: command.action,
          output,
        };
      } catch (error: unknown) {
        const rawMessage = error instanceof Error ? error.message : String(error);
        const message = redactText(rawMessage, secretEnvironment);
        return { ok: false, error: message.slice(0, 8_000) };
      }
    },
  };
}
