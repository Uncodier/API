import type { PublicStatusSummary, PublicSystemCard } from './get-public-summary';
import { getCachedJson, setCachedJson } from '@/lib/security/upstash-rest';
import { aiAudioHandler } from './handlers/ai/audio';
import { aiImageHandler } from './handlers/ai/image';
import { aiVideoHandler } from './handlers/ai/video';
import { cronHandler } from './handlers/cron';
import { integrationsHandler } from './handlers/integrations';
import { notificationsHandler } from './handlers/notifications';
import { apiAuthHandler } from './handlers/auth';
import { probeOpenRouterText } from './handlers/ai/provider-probes';
import { buildHealthResponse, evaluateAiProviders, sanitizePublicPayload, type SystemHealthResponse } from './types';
import { overallHealth, summarizeObservations } from './observation';

const pending = new Map<string, Promise<SystemHealthResponse[]>>();
const PASSIVE_CACHE_SECONDS = 15;

async function readPassiveCards(key: string): Promise<SystemHealthResponse[]> {
  const cached = await getCachedJson<SystemHealthResponse[]>(key);
  if (cached) return cached;
  const inFlight = pending.get(key);
  if (inFlight) return inFlight;
  const read = (async () => {
    // This explicit passive-only path never inherits STATUS_AI_PROBE_ENABLED.
    const [text, ...others] = await Promise.all([
      probeOpenRouterText({ passiveOnly: true }),
      ...[aiAudioHandler, aiImageHandler, aiVideoHandler, cronHandler,
        integrationsHandler, notificationsHandler, apiAuthHandler].map(handler => handler.runCheck()),
    ]);
    const providers = { openrouter: text };
    const { status, degradedReasons } = evaluateAiProviders(providers, ['openrouter']);
    const summary = text.verification === 'passive'
      ? `OpenRouter text: recent request ${text.observedHealthy ? 'completed successfully' : 'failed'}`
      : status === 'down' ? 'OpenRouter text is not configured' : 'Text generation unverified: no fresh operation receipt';
    const cards = ['ai_portkey', 'ai_text'].map(systemKey => buildHealthResponse({
      systemKey, label: systemKey === 'ai_text' ? 'AI Text' : 'AI OpenRouter', status,
      summary, latencyMs: text.latencyMs, degradedReasons,
      checks: { providers, verification: text.verification ?? 'configuration', observedAt: text.observedAt },
    }));
    const result = sanitizePublicPayload([...cards, ...others]);
    await setCachedJson(key, result, PASSIVE_CACHE_SECONDS);
    return result;
  })();
  pending.set(key, read);
  try { return await read; } finally { pending.delete(key); }
}

/** Refresh current evidence independently of the hourly historical snapshot.
 * Reads only: no probes, provider SDK requests, jobs, sends or history writes. */
export async function refreshPassiveSummary(summary: PublicStatusSummary): Promise<PublicStatusSummary> {
  if (!summary.systems.length) return summary;
  try {
    const current = await readPassiveCards(`cache:status:passive:v1:${summary.lastRunAt ?? 'none'}`);
    const byKey = new Map(current.map(card => [card.systemKey, card]));
    const systems = summary.systems.map((stored): PublicSystemCard => {
      const fresh = byKey.get(stored.systemKey);
      if (!fresh) return stored;
      return { ...stored, status: fresh.status, summary: fresh.summary, checkedAt: fresh.checkedAt,
        latencyMs: fresh.latencyMs, checks: fresh.checks };
    });
    const text = byKey.get('ai_text');
    if (text) {
      const index = systems.findIndex(card => card.systemKey === 'ai_text_continuation');
      if (index >= 0) {
        const stored = systems[index];
        // Keep the last safe route observation; a parent receipt does not prove
        // continuation registration, and never triggers another HTTP request.
        const routeOk = stored.checks.continuationRouteRegistered === true
          && [400, 405].includes(Number(stored.checks.continuationHttpStatus));
        systems[index] = { ...stored, status: !routeOk ? stored.status : text.status,
          checks: { ...stored.checks, parentHealthy: text.status === 'up', parentStatus: text.status,
            inheritedProviders: text.checks.providers, verification: !routeOk ? 'contract' : text.checks.verification,
            parentObservedAt: text.checks.observedAt },
          summary: !routeOk ? stored.summary : text.status === 'up'
            ? 'Continuation contract reachable; recent parent text execution verified'
            : text.status === 'down' ? 'Continuation parent text operation failed'
              : 'Continuation contract reachable; parent text generation unverified',
        };
      }
    }
    const state = overallHealth(systems);
    const overall = state === 'healthy' ? 'operational' : state;
    return { ...summary, systems, overall: summary.stale || summary.sourceUnavailable
      ? overall === 'down' ? 'down' : 'degraded' : overall,
      observation: summarizeObservations(systems) };
  } catch {
    // A read error is not successful execution. Retain the prior snapshot but
    // expose that fresh passive evidence could not be obtained.
    return { ...summary, sourceUnavailable: true,
      overall: summary.overall === 'down' ? 'down' : 'degraded' };
  }
}