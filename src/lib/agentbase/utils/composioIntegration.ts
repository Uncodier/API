import type { DbCommand } from '../models/types';

export interface ComposioIntegrationConfig {
  enabled?: boolean;
  apiKey?: string;
  entityId?: string;
  apps?: string[];
  tags?: string[];
  integrationId?: string;
  filterByAvailableApps?: boolean;
}

// Compatibility only: generic commands have no per-account connector execution authority.
// Do not retain global credentials, discover account tools, or add SDK handlers here.
export function isComposioEnabled(): boolean { return false; }
export function getComposioConfig(): ComposioIntegrationConfig { return { enabled: false, apps: [] }; }
export function configureComposio(config: ComposioIntegrationConfig): void {
  if (config.enabled) throw new Error('Global command connectors are disabled. Use the authorized connector host.');
}
export function enableComposioWithApps(_apps: string[], _config?: Partial<ComposioIntegrationConfig>): void {
  configureComposio({ enabled: true });
}
export function disableComposio(): void { /* Already disabled. */ }
export class ComposioConfiguration {
  private static instance = new ComposioConfiguration();
  private constructor() {}
  static getInstance() { return this.instance; }
  configure(config: ComposioIntegrationConfig) { configureComposio(config); }
  getConfiguration() { return getComposioConfig(); }
  isEnabled() { return false; }
}
export async function enrichWithComposioTools(command: DbCommand, _options?: ComposioIntegrationConfig): Promise<DbCommand> {
  return command;
}
