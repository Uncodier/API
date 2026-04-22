import type { UncodieClient } from './client';

export interface TrackEventInput {
  event: string;
  properties?: Record<string, unknown>;
}

export function createTrackingModule(client: UncodieClient) {
  return {
    event(input: TrackEventInput): Promise<{ accepted: boolean }> {
      if (!input.event) throw new Error('[uncodie.tracking] `event` is required.');
      return client.post('tracking/event', input);
    },
  };
}
