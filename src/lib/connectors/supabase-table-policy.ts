import { ConnectorError, type Connector } from './types';

export const TABLE_TOOL = 'SUPABASE_LIST_TABLES';
export const DATABASE_READ = 'Database:Read';
export function isBoundSupabaseProject(connector: Connector): boolean {
  return connector.toolkit_slug === 'supabase' && typeof connector.supabase_project_ref === 'string'
    && /^[a-z]{20}$/.test(connector.supabase_project_ref) && connector.supabase_project_ref.length === 20;
}

// Only verified provisioning can write this binding. Do not infer it from a display
// name, environment, or agent. Omit `schemas` to request all non-system schemas.
export function tableArguments(connector: Connector) {
  if (!isBoundSupabaseProject(connector)) {
    throw new ConnectorError('CONNECTOR_PROJECT_UNBOUND', 'A verified Supabase project binding is required.', 409);
  }
  return { project_ref: connector.supabase_project_ref!, include_metadata: false, include_views: false, include_system_schemas: false };
}
