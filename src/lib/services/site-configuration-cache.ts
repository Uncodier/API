import { invalidateAgentCachesForSite } from '@/lib/agentbase/services/agent/AgentCacheService';
import {
  deleteRedisKeys,
  writeRedisJson,
} from './redis-json-cache';

const SETTINGS_TTL_SECONDS = 300;

export async function refreshSiteConfigurationCaches(
  siteId: string,
  settingsSnapshot?: Record<string, unknown>,
): Promise<void> {
  const settingsKey = `cache:site-settings:${siteId}`;
  if (settingsSnapshot) {
    await writeRedisJson(settingsKey, settingsSnapshot, SETTINGS_TTL_SECONDS);
  } else {
    await deleteRedisKeys(settingsKey);
  }
  await deleteRedisKeys(`cache:site-email-settings:${siteId}`);
  await invalidateAgentCachesForSite(siteId);
}
