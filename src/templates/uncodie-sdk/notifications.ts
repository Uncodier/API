import type { UncodieClient } from './client';

export interface CreateNotificationInput {
  title: string;
  /** Non-empty details are required (message or the legacy body alias). */
  message?: string;
  type?: 'info' | 'warning' | 'error' | 'success';
  /** @deprecated Use message. */
  body?: string;
  /** @deprecated Use type; warn is normalized to warning. */
  level?: 'info' | 'warn' | 'error' | 'success';
  /** @deprecated Ignored: notifications have no metadata column. */
  metadata?: Record<string, unknown>;
}

export function createNotificationsModule(client: UncodieClient) {
  return {
    /** Creates an in-app notification for the site owner, linked to the key's requirement or site. */
    create(input: CreateNotificationInput): Promise<{ id: string }> {
      if (!input.title?.trim()) throw new Error('[uncodie.notifications] `title` is required.');
      if (!(input.message ?? input.body)?.trim()) {
        throw new Error('[uncodie.notifications] Non-empty `message` (or legacy `body`) details are required.');
      }
      return client.post('notifications', input);
    },
  };
}
