import { hashConnectorSchema } from './composio-tool-json';
import { snapshotDirectJson } from './provider-direct-schema';
import { executeGenericSupport } from './support-generic-execution';
import { denied } from './support-runtime-access';
import { discoverSupport } from './support-runtime-discovery';
import { memberSupportScope, supportConnectorTool, supportInput, type SupportConnectorHost } from './support-runtime-contract';
import { ConnectorError } from './types';

export * from './support-runtime-contract';

export async function executeSupportConnectorTool(host: SupportConnectorHost, name: string, args: unknown) {
  try {
    if (name !== supportConnectorTool.name) throw denied();
    const currentScope = async () => {
      const scope = memberSupportScope.parse(await host.resolve());
      if (scope.siteId !== host.siteId || scope.agentId !== host.agentId) throw denied();
      return scope;
    };
    const scope = await currentScope();
    const snapshot = snapshotDirectJson(args);
    if (Buffer.byteLength(JSON.stringify(snapshot)) > 8192) throw denied();
    const request = supportInput.parse(snapshot);
    const recheckHost = async () => {
      if (hashConnectorSchema(scope) !== hashConnectorSchema(await currentScope())) throw denied();
    };
    if (request.action === 'list' || request.action === 'search') return await discoverSupport(scope, request, recheckHost);
    return await executeGenericSupport(scope, request, recheckHost);
  } catch (error) {
    if (error instanceof ConnectorError && error.code === 'STALE_CURSOR') {
      return { success: false, status: 'stale_cursor', hint: 'Repeat the search or list without the cursor.' };
    }
    return { success: false, status: 'unavailable' };
  }
}
