import { UncodieClient, type UncodieClientOptions } from './client';
import { createEmailModule } from './email';
import { createLeadsModule } from './leads';
import { createNotificationsModule } from './notifications';
import { createTrackingModule } from './tracking';
import { createAgentsModule } from './agents';

export { UncodieClient, UncodieApiError } from './client';

export interface UncodieSdk {
  client: UncodieClient;
  email: ReturnType<typeof createEmailModule>;
  leads: ReturnType<typeof createLeadsModule>;
  notifications: ReturnType<typeof createNotificationsModule>;
  tracking: ReturnType<typeof createTrackingModule>;
  agents: ReturnType<typeof createAgentsModule>;
}

export function createUncodieSdk(options?: UncodieClientOptions): UncodieSdk {
  const client = new UncodieClient(options);
  return {
    client,
    email: createEmailModule(client),
    leads: createLeadsModule(client),
    notifications: createNotificationsModule(client),
    tracking: createTrackingModule(client),
    agents: createAgentsModule(client),
  };
}

let _singleton: UncodieSdk | null = null;

/**
 * Lazy singleton read from env — import `uncodie` in app code to avoid
 * re-instantiating the client on every request.
 */
export const uncodie: UncodieSdk = new Proxy({} as UncodieSdk, {
  get(_target, prop) {
    if (!_singleton) _singleton = createUncodieSdk();
    return (_singleton as Record<string, any>)[prop as string];
  },
});
