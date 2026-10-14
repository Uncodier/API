import { workspaceProviderDiagnostic, type WorkspaceProviderOperation } from './workspace-provider-diagnostic';

/** Preserve useful provider classifications without serializing SDK errors/URLs/tokens. */
export function workspaceOpenFailure(error: unknown, operation?: WorkspaceProviderOperation): { code: string; message: string; operatorRequired: boolean } {
  const failure = classifyFailure(error);
  return { ...failure, message: failure.message + workspaceProviderDiagnostic(error, operation) };
}

function classifyFailure(error: unknown): { code: string; message: string; operatorRequired: boolean } {
  const candidate = error as { name?: string; response?: { status?: number; statusCode?: number }; status?: number } | null;
  if (['LocalOidcContextError', 'VercelOidcContextError', 'SandboxAuthConfigurationError'].includes(candidate?.name || '')) {
    return { code: 'WORKSPACE_AUTH_CONFIGURATION_REQUIRED', operatorRequired: true,
      message: 'Sandbox authentication context is unavailable. Configure Vercel OIDC on this host or explicitly select HARNESS_SANDBOX_AUTH=access-token with a complete token/team/project scope. No alternate credentials or project were selected.' };
  }
  const status = candidate?.response?.status ?? candidate?.response?.statusCode ?? candidate?.status;
  if (status === 401 || status === 403) return { code: 'WORKSPACE_AUTHORIZATION_REQUIRED',
    message: `Sandbox provider rejected workspace access (HTTP ${status}). Check the host token and team/project scope. Existing work was preserved.`, operatorRequired: true };
  if (status === 402) return { code: 'WORKSPACE_PROVIDER_BILLING_REQUIRED',
    message: 'Sandbox provider rejected workspace access (HTTP 402). Check provider billing; site credits are separate. Existing work was preserved.', operatorRequired: true };
  if (typeof status === 'number' && Number.isInteger(status) && status >= 400 && status <= 599) {
    return { code: 'WORKSPACE_OPEN_FAILED', message: `Sandbox workspace request failed (HTTP ${status}). Existing state was not recreated or reset.`, operatorRequired: false };
  }
  return { code: 'WORKSPACE_OPEN_FAILED', message: 'Workspace could not be opened. Existing state was not recreated or reset.', operatorRequired: false };
}

export function workspaceOpenRequiresOperator(error: unknown): boolean {
  const candidate = error as { name?: string; code?: string } | null;
  return candidate?.name === 'WorkspaceError' && ['WORKSPACE_AUTHORIZATION_REQUIRED', 'WORKSPACE_PROVIDER_BILLING_REQUIRED', 'WORKSPACE_AUTH_CONFIGURATION_REQUIRED'].includes(candidate.code || '');
}