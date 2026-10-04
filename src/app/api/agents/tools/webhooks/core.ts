import { getMakinariClient } from './client';

export async function getWebhooks() {
  const client = getMakinariClient();
  return client.getWebhooks();
}

export async function createWebhook(url: string, events: string[]) {
  const client = getMakinariClient();
  return client.createWebhook(url, events);
}

