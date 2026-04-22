import type { UncodieClient } from './client';

export interface CreateNotificationInput {
  title: string;
  body?: string;
  level?: 'info' | 'warn' | 'error' | 'success';
  metadata?: Record<string, unknown>;
}

export function createNotificationsModule(client: UncodieClient) {
  return {
    create(input: CreateNotificationInput): Promise<{ id: string }> {
      if (!input.title) throw new Error('[uncodie.notifications] `title` is required.');
      return client.post('notifications', input);
    },
  };
}
