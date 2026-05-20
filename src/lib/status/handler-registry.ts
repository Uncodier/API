import type { SystemHealthHandler } from '@/lib/status/types';
import { databaseMainHandler } from '@/lib/status/handlers/database';
import { databaseAppsHandler } from '@/lib/status/handlers/database-apps';
import { envCoreHandler } from '@/lib/status/handlers/env-core';
import { apiAuthHandler } from '@/lib/status/handlers/auth';
import { publicApiHandler } from '@/lib/status/handlers/public-api';
import { agentsHandler } from '@/lib/status/handlers/agents';
import { workflowHandler } from '@/lib/status/handlers/workflow';
import { integrationsHandler } from '@/lib/status/handlers/integrations';
import { siteHandler } from '@/lib/status/handlers/site';
import { visitorsHandler } from '@/lib/status/handlers/visitors';
import { finderHandler } from '@/lib/status/handlers/finder';
import { robotsHandler } from '@/lib/status/handlers/robots';
import { cronHandler } from '@/lib/status/handlers/cron';
import { platformHandler } from '@/lib/status/handlers/platform';
import { notificationsHandler } from '@/lib/status/handlers/notifications';
import { aiPortkeyHandler } from '@/lib/status/handlers/ai/portkey';
import { aiTextHandler } from '@/lib/status/handlers/ai/text';
import { aiTextContinuationHandler } from '@/lib/status/handlers/ai/text-continuation';
import { aiImageHandler } from '@/lib/status/handlers/ai/image';
import { aiVideoHandler } from '@/lib/status/handlers/ai/video';
import { aiAudioHandler } from '@/lib/status/handlers/ai/audio';

const HANDLERS: SystemHealthHandler[] = [
  databaseMainHandler,
  databaseAppsHandler,
  envCoreHandler,
  apiAuthHandler,
  publicApiHandler,
  agentsHandler,
  workflowHandler,
  integrationsHandler,
  siteHandler,
  visitorsHandler,
  finderHandler,
  robotsHandler,
  cronHandler,
  platformHandler,
  notificationsHandler,
  aiPortkeyHandler,
  aiTextHandler,
  aiTextContinuationHandler,
  aiImageHandler,
  aiVideoHandler,
  aiAudioHandler,
];

export function getAllHealthHandlers(): SystemHealthHandler[] {
  return [...HANDLERS];
}

export function getHealthHandler(systemKey: string): SystemHealthHandler | undefined {
  return HANDLERS.find((h) => h.systemKey === systemKey);
}

export function getHandlerSystemKeys(): string[] {
  return HANDLERS.map((h) => h.systemKey);
}
