import type { Sandbox } from '@vercel/sandbox';
import {
  installWorkflowAgentBrowser,
  runWorkflowAgentBrowserCommand,
} from './agent-browser-runtime';
import { workflowStepSuggestsBrowserInteraction } from './browser-interaction';

const READY_MARKER = '/vercel/sandbox/.makinari-agent-browser-ready-v1';
const BROWSER_LANGUAGE =
  /\b(agent-browser|browser|browse|computer vision|visual navigation|navigate|navigation|open|visit|go to|log in|login|navegar|navegación|abrir|visitar|ingresar|vista computacional|sitio web|website|webpage|página web)\b/i;
const URL_PATTERN = /https?:\/\/[^\s]+/i;

export function workflowStepRequiresBrowser(step: Record<string, any>): boolean {
  if (workflowStepSuggestsBrowserInteraction(step)) return true;
  if (typeof step.requires_browser === 'boolean') return step.requires_browser;
  if (typeof step.metadata?.requires_browser === 'boolean') {
    return step.metadata.requires_browser;
  }
  if (step.skill === 'makinari-tool-agent-browser') return true;
  const actions = Array.isArray(step.metadata?.mcp_actions)
    ? step.metadata.mcp_actions
    : [];
  if (actions.some((action: any) =>
    BROWSER_LANGUAGE.test(`${action?.tool || ''} ${action?.action || ''}`))) {
    return true;
  }
  const text = `${step.title || ''}\n${step.description || ''}\n${step.instructions || ''}`;
  return BROWSER_LANGUAGE.test(text) || URL_PATTERN.test(text);
}

async function hasReadyMarker(sandbox: Sandbox): Promise<boolean> {
  const probe = await sandbox.runCommand({
    cmd: 'sh',
    args: ['-c', `test -f "${READY_MARKER}"`],
  });
  return probe.exitCode === 0;
}

async function markReady(sandbox: Sandbox): Promise<void> {
  const result = await sandbox.runCommand({
    cmd: 'sh',
    args: ['-c', `mkdir -p "$(dirname "${READY_MARKER}")" && touch "${READY_MARKER}"`],
  });
  if (result.exitCode !== 0) {
    throw new Error(`Could not persist agent-browser readiness: ${await result.stderr()}`);
  }
}

async function browserLaunches(sandbox: Sandbox): Promise<boolean> {
  try {
    await runWorkflowAgentBrowserCommand(
      sandbox,
      ['open', 'about:blank'],
      { json: false, session: 'makinari-preflight' },
    );
    await runWorkflowAgentBrowserCommand(
      sandbox,
      ['close'],
      { json: false, session: 'makinari-preflight' },
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Makes browser workflows deterministic before an LLM turn starts.
 * Persistent sandboxes pay the installation cost once; production can use
 * AGENT_BROWSER_SNAPSHOT_ID to boot a prebuilt browser image.
 */
export async function ensureWorkflowBrowserReady(
  sandbox: Sandbox,
  allowedDomains: string[] = [],
): Promise<void> {
  const mutableSandbox = sandbox as unknown as {
    update?: (params: Record<string, unknown>) => Promise<unknown>;
  };
  const applyRuntimePolicy = async () => {
    if (allowedDomains.length === 0) return;
    if (typeof mutableSandbox.update !== 'function') {
      throw new Error('Sandbox SDK cannot enforce browser_allowed_domains.');
    }
    await mutableSandbox.update({ networkPolicy: { allow: allowedDomains } });
  };

  if (await hasReadyMarker(sandbox)) {
    await applyRuntimePolicy();
    return;
  }
  if (typeof mutableSandbox.update === 'function') {
    await mutableSandbox.update({ networkPolicy: 'allow-all' });
  }
  if (await browserLaunches(sandbox)) {
    await markReady(sandbox);
    await applyRuntimePolicy();
    return;
  }

  await installWorkflowAgentBrowser(sandbox);
  if (!await browserLaunches(sandbox)) {
    throw new Error('agent-browser installation completed, but Chrome failed its launch preflight.');
  }
  await markReady(sandbox);
  await applyRuntimePolicy();
}
