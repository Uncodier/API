export class ConnectorError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 400) {
    super(message);
    this.name = 'ConnectorError';
  }
}

/** Trusted host context. Never construct authority from model arguments. */
export type ConnectorContext = {
  siteId: string;
  userId: string;
  agentId?: string;
  instanceId?: string;
  requestId?: string;
  sourceDigest?: string;
  /** A conversation selection can narrow authority, never supply it. */
  connectorIdHint?: string;
  /** Admitted from a verified non-anonymous user session, never a site API key. */
  catalogUserSession?: true;
  host: 'assistant' | 'workflow' | 'direct';
};

export type ConnectorProvider = {
  id: string;
  site_id: string;
  provider: 'composio';
  project_id: string;
  provider_user_id: string;
  credential_revision: string;
  status: string;
};

export type Connector = {
  id: string;
  site_id: string;
  provider_id: string;
  provider_project_id: string;
  toolkit_slug: string;
  provider_account_id: string;
  auth_config_id: string;
  display_name: string;
  supabase_project_ref?: string | null;
  provider_status: string;
  enabled: boolean;
  access_mode?: ConnectorAccessMode;
  revocation_pending: boolean;
  revocation_dispatched?: boolean;
  granted_scopes: string[];
  created_by: string;
  revision: number;
  verified_at: string | null;
};

export type ConnectorMemberGrant = {
  user_id: string;
  can_view: boolean;
  can_use: boolean;
  expires_at: string | null;
  revoked_at?: string | null;
};

export type ConnectorAgentGrant = {
  agent_id: string;
  enabled: boolean;
  expires_at: string | null;
  revoked_at?: string | null;
};

export type ConnectorToolAccessMode = 'all' | 'selected';

export function connectorToolAccessMode(mode: unknown): ConnectorToolAccessMode {
  return mode === 'all' ? 'all' : 'selected';
}

export type ConnectorPolicy = {
  /** Absent on legacy policies. Never inferred from all mode or selected IDs. */
  catalog_reads?: boolean;
  support_publication?: import('./support-policy').SupportPublication | null;
  tool_access_mode?: ConnectorToolAccessMode;
  allowed_tools: string[];
  allowed_hosts: string[];
  require_approval: boolean;
  revision?: number;
};

export type AuthorizedConnector = {
  /** Server-only project identity proven by this actor's successful authorization RPC. Never a grant. */
  localProjectRef?: string;
  /** Set only by request-capable resolution; never an execution grant. */
  requestOnly?: true;
  connector: Connector;
  provider: ConnectorProvider;
  policy: ConnectorPolicy;
};

export type ConnectorAccessMode = 'explicit' | 'workspace';

export function connectorAccessMode(connector: Pick<Connector, 'access_mode'>): ConnectorAccessMode {
  return connector.access_mode === 'workspace' ? 'workspace' : 'explicit';
}

export const CONNECTOR_COLUMNS = 'id,site_id,provider_id,provider_project_id,toolkit_slug,provider_account_id,auth_config_id,display_name,supabase_project_ref,provider_status,enabled,access_mode,revocation_pending,revocation_dispatched,granted_scopes,created_by,revision,verified_at';
export const PROVIDER_COLUMNS = 'id,site_id,provider,project_id,provider_user_id,credential_revision,status';

export function isGrantCurrent(grant: { revoked_at?: string | null; expires_at?: string | null }, now = Date.now()): boolean {
  return !grant.revoked_at && (grant.expires_at == null || Date.parse(grant.expires_at) > now);
}