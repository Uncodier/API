import type { HostConfiguration, HostStateStore } from './types';
import { runtimeSecretValues } from './security';

/** Host-only configuration, independently versioned and encrypted by the store. */
export async function loadSessionConfiguration(store: HostStateStore, scope: { id: string; siteId: string; owner: string }) {
  let { version, configuration } = await store.load(scope.id, scope.siteId, scope.owner);
  return {
    get configuration(): HostConfiguration { return structuredClone(configuration); },
    values(): Record<string, string> {
      const layers = Object.entries(configuration.layers).sort(([a], [b]) => a === 'profile' ? -1 : b === 'profile' ? 1 : a.localeCompare(b));
      return Object.assign({}, ...layers.map(([, layer]) => layer.values));
    },
    async setLayer(name: string, layer: HostConfiguration['layers'][string], extraSecrets: string[] = []) {
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) throw new Error('Invalid host configuration layer');
      const next = structuredClone(configuration);
      next.redactionValues = [...new Set([...next.redactionValues,
        ...runtimeSecretValues(configuration.layers[name]?.values || {}),
        ...runtimeSecretValues(layer.values), ...extraSecrets].filter(Boolean))];
      next.layers[name] = structuredClone(layer);
      const nextVersion = await store.save(scope.id, scope.siteId, scope.owner, version, next);
      version = nextVersion; configuration = next;
    },
    async remember(values: string[]) {
      const redactionValues = [...new Set([...configuration.redactionValues, ...values.filter(Boolean)])];
      if (redactionValues.length !== configuration.redactionValues.length) {
        const next = { ...configuration, redactionValues };
        version = await store.save(scope.id, scope.siteId, scope.owner, version, next);
        configuration = next;
      }
    },
  };
}